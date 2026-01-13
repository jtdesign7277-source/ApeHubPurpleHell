require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 8080;

// Stripe Configuration - loads from .env file
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ===== DATABASE SETUP =====
const db = new sqlite3.Database('subscriptions.db', (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('Connected to SQLite database');
    // Create subscriptions table if it doesn't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT UNIQUE,
        email TEXT,
        stripe_subscription_id TEXT,
        price_id TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('Table creation error:', err);
      else console.log('Subscriptions table ready');
    });
  }
});

// Helper function to update subscription in database
const updateSubscription = (customerId, email, subscriptionId, priceId, status) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO subscriptions (customer_id, email, stripe_subscription_id, price_id, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET
       stripe_subscription_id = excluded.stripe_subscription_id,
       price_id = excluded.price_id,
       status = excluded.status,
       updated_at = CURRENT_TIMESTAMP`,
      [customerId, email, subscriptionId, priceId, status],
      function(err) {
        if (err) {
          console.error('Database update error:', err);
          reject(err);
        } else {
          console.log('Subscription updated for customer:', customerId);
          resolve();
        }
      }
    );
  });
};

// Helper function to get subscription status
const getSubscription = (customerId) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM subscriptions WHERE customer_id = ?',
      [customerId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
};

// Middleware - CRITICAL ORDER!
// 1. Webhook FIRST (uses raw body)
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

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('📦 Checkout session completed:', session.id);
        console.log('  Customer:', session.customer_email);
        
        // Retrieve full subscription details
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
        
        console.log('✓ Subscription status updated');
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
        
        console.log('✓ Subscription marked as cancelled');
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        console.log('💰 Payment intent succeeded:', paymentIntent.id);
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

// 2. Then JSON parser for regular API routes
app.use(express.json({ limit: '10mb' }));

// Logging middleware with cache-busting headers
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  // Disable caching for HTML files
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// 4. API Routes
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
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl || `${req.headers.origin}/dashboard.html?payment=success`,
      cancel_url: cancelUrl || `${req.headers.origin}/LandingPurple%20_%20DailyEdgeFinance.html?payment=cancelled`,
    });

    console.log('Session created successfully:', session.id);
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe error:', error.message);
    console.error('Full error:', error);
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
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve static files (after all API routes!)
app.use(express.static(__dirname));

// Serve the landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'LandingPurple _ DailyEdgeFinance.html'));
});

// Serve ONLY the Purple Hell app files and assets folder
app.use('/LandingPurple _ DailyEdgeFinance_files', express.static(path.join(__dirname, 'LandingPurple _ DailyEdgeFinance_files')));
app.use(express.static(path.join(__dirname), {
  index: false
}));

// Serve the landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'LandingPurple _ DailyEdgeFinance.html'));
});

// Block base44 and other old pages
app.get('/base44*', (req, res) => res.status(404).send('Not found'));
app.get('*.supabase*', (req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Serving Purple Hell app only');
});

