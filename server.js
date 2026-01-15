require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;

// Stripe Configuration
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ===== POSTGRESQL DATABASE SETUP =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    // Create subscriptions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        customer_id TEXT UNIQUE,
        email TEXT,
        stripe_subscription_id TEXT,
        price_id TEXT,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Subscriptions table ready');

    // Create waitlist table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        source TEXT DEFAULT 'waitlist',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Waitlist table ready');

    // Create user_data table for watchlists and portfolios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_data (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        watchlist JSONB DEFAULT '[]',
        positions JSONB DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ User data table ready');

    console.log('✓ Connected to PostgreSQL database');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

initDatabase();

// Helper function to update subscription in database
const updateSubscription = async (customerId, email, subscriptionId, priceId, status) => {
  try {
    await pool.query(
      `INSERT INTO subscriptions (customer_id, email, stripe_subscription_id, price_id, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id) DO UPDATE SET
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       price_id = EXCLUDED.price_id,
       status = EXCLUDED.status,
       updated_at = CURRENT_TIMESTAMP`,
      [customerId, email, subscriptionId, priceId, status]
    );
    console.log('Subscription updated for customer:', customerId);
  } catch (err) {
    console.error('Database update error:', err);
    throw err;
  }
};

// Helper function to get subscription status
const getSubscription = async (customerId) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE customer_id = $1',
      [customerId]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Database query error:', err);
    throw err;
  }
};

// ===== WAITLIST API =====
app.post('/api/waitlist', express.json(), async (req, res) => {
  const { email, source } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  try {
    await pool.query(
      `INSERT INTO waitlist (email, source) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
      [email, source || 'waitlist']
    );
    console.log('✓ New waitlist signup:', email);
    res.json({ success: true, message: 'Added to waitlist!' });
  } catch (err) {
    console.error('Waitlist error:', err);
    res.status(500).json({ error: 'Failed to add to waitlist' });
  }
});

// Get all waitlist emails (admin endpoint)
app.get('/api/waitlist', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch waitlist' });
  }
});

// ===== USER DATA API =====
// Get user's watchlist and positions
app.get('/api/user-data/:email', async (req, res) => {
  const { email } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT watchlist, positions FROM user_data WHERE email = $1',
      [email]
    );
    
    if (result.rows.length > 0) {
      res.json({
        success: true,
        watchlist: result.rows[0].watchlist || [],
        positions: result.rows[0].positions || {}
      });
    } else {
      // Return empty defaults for new user
      res.json({
        success: true,
        watchlist: [],
        positions: {}
      });
    }
  } catch (err) {
    console.error('Error fetching user data:', err);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// Save user's watchlist and positions
app.post('/api/user-data', express.json(), async (req, res) => {
  const { email, watchlist, positions } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  try {
    await pool.query(
      `INSERT INTO user_data (email, watchlist, positions, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO UPDATE SET
       watchlist = EXCLUDED.watchlist,
       positions = EXCLUDED.positions,
       updated_at = CURRENT_TIMESTAMP`,
      [email, JSON.stringify(watchlist || []), JSON.stringify(positions || {})]
    );
    
    console.log('✓ Saved user data for:', email);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving user data:', err);
    res.status(500).json({ error: 'Failed to save user data' });
  }
});

// ===== LOGIN API =====
app.post('/api/login', express.json(), async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE email = $1 AND status = $2',
      [email, 'active']
    );
    
    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log('✓ Paid user logged in:', email);
      res.json({ 
        success: true, 
        message: 'Login successful!',
        user: { email: row.email, status: row.status }
      });
    } else {
      console.log('✗ Login denied (no active subscription):', email);
      res.json({ 
        success: false, 
        message: 'No active subscription found. Please subscribe to access the dashboard.'
      });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ===== STRIPE WEBHOOK =====
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    console.log('✓ Webhook signature verified');
  } catch (err) {
    console.log(`✗ Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('📦 Checkout session completed:', session.id);
        console.log('  Customer:', session.customer_email);
        
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const customerId = session.customer || subscription.customer;
        
        await updateSubscription(
          customerId,
          session.customer_email,
          session.subscription,
          subscription.items.data[0].price.id,
          'active'
        );
        
        console.log('✓ Subscription saved to database');
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        console.log('🔄 Subscription updated:', subscription.id);
        
        await updateSubscription(
          subscription.customer,
          subscription.metadata?.email || '',
          subscription.id,
          subscription.items.data[0].price.id,
          subscription.status
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        console.log('❌ Subscription cancelled:', subscription.id);
        
        await updateSubscription(
          subscription.customer,
          subscription.metadata?.email || '',
          subscription.id,
          subscription.items.data[0].price.id,
          'cancelled'
        );
        break;
      }

      default:
        console.log(`ℹ Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. JSON parser for regular API routes
app.use(express.json({ limit: '10mb' }));

// Admin endpoint to view all subscriptions
app.get('/api/subscriptions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM subscriptions ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoint to manually add a subscription
app.post('/api/add-subscription', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  try {
    await pool.query(
      `INSERT INTO subscriptions (customer_id, email, stripe_subscription_id, price_id, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id) DO UPDATE SET
       email = EXCLUDED.email,
       status = EXCLUDED.status,
       updated_at = CURRENT_TIMESTAMP`,
      ['manual_' + Date.now(), email, 'manual_sub_' + Date.now(), 'manual', 'active']
    );
    res.json({ success: true, message: `Subscription added for ${email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Create Checkout Session endpoint
app.post('/api/create-checkout-session', async (req, res) => {
  console.log('Checkout session request received:', req.body);
  try {
    const { priceId, successUrl, cancelUrl, email } = req.body;
    console.log('Creating session with priceId:', priceId, 'email:', email);
    
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${req.headers.origin}/dashboard.html?payment=success`,
      cancel_url: cancelUrl || `${req.headers.origin}/landing.html?payment=cancelled`,
    });

    console.log('Session created successfully:', session.id);
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get subscription status
app.get('/api/subscription-status/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const subscription = await getSubscription(customerId);
    
    if (subscription) {
      res.json({
        subscribed: subscription.status === 'active',
        status: subscription.status,
        priceId: subscription.price_id,
        email: subscription.email,
        createdAt: subscription.created_at
      });
    } else {
      res.json({ subscribed: false, status: 'none' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve landing page at root
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'landing.html'));
});

// Serve static files
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

app.get('/dashboard.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/chat.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/markets.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'markets.html'));
});

app.get('/charts.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'charts.html'));
});

app.get('/news.html', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'news.html'));
});

app.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'LandingPurple _ DailyEdgeFinance.html'));
});

// Serve assets
app.use('/LandingPurpleFiles', express.static(path.join(__dirname, 'LandingPurpleFiles')));
app.use('/intro-music.mp3', express.static(path.join(__dirname, 'intro-music.mp3')));

// ===== YAHOO FINANCE PROXY =====
app.get('/api/futures/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const validSymbols = ['ES=F', 'YM=F', 'NQ=F', 'RTY=F'];
    
    if (!validSymbols.includes(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`);
    const data = await response.json();
    
    res.json(data);
  } catch (error) {
    console.error('Futures API error:', error);
    res.status(500).json({ error: 'Failed to fetch futures data' });
  }
});

// 404 handler
app.use((req, res) => {
  console.log('BLOCKED REQUEST:', req.method, req.path);
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`\n=====================================`);
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Started at: ${new Date().toISOString()}`);
  console.log(`✓ Using PostgreSQL database`);
  console.log(`=====================================\n`);
});

