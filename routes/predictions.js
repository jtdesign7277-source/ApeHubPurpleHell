// =====================================================
// PREDICTIONS MARKET API ROUTES
// Add these routes to your server.js
// =====================================================

const express = require('express');
const router = express.Router();

// Token package configuration
const TOKEN_PACKAGES = {
  starter: {
    id: 'starter',
    name: 'Starter Pack',
    tokens: 250,
    price_cents: 499,
    price_display: '$4.99',
    stripe_price_id: process.env.STRIPE_PRICE_TOKENS_250 || 'price_tokens_250'
  },
  popular: {
    id: 'popular',
    name: 'Popular Pack',
    tokens: 1000,
    price_cents: 999,
    price_display: '$9.99',
    stripe_price_id: process.env.STRIPE_PRICE_TOKENS_1000 || 'price_tokens_1000',
    badge: 'BEST VALUE'
  },
  whale: {
    id: 'whale',
    name: 'Whale Pack',
    tokens: 2500,
    price_cents: 1499,
    price_display: '$14.99',
    stripe_price_id: process.env.STRIPE_PRICE_TOKENS_2500 || 'price_tokens_2500',
    badge: 'MOST TOKENS'
  }
};

// Token to USD conversion for payouts
const TOKENS_TO_USD_RATE = 0.004;
const MIN_PAYOUT_TOKENS = 1000;

// =====================================================
// MIDDLEWARE: Get or create user token account
// =====================================================
async function getOrCreateTokenAccount(pool, email) {
  let result = await pool.query(
    'SELECT * FROM user_tokens WHERE user_email = $1',
    [email]
  );
  
  if (result.rows.length > 0) {
    return result.rows[0];
  }
  
  result = await pool.query(
    `INSERT INTO user_tokens (user_email, balance) 
     VALUES ($1, 0) 
     RETURNING *`,
    [email]
  );
  
  return result.rows[0];
}

// =====================================================
// TOKEN ROUTES
// =====================================================

// GET /api/predictions/tokens/packages
router.get('/tokens/packages', (req, res) => {
  res.json({
    success: true,
    packages: Object.values(TOKEN_PACKAGES)
  });
});

// GET /api/predictions/tokens/balance
router.get('/tokens/balance', async (req, res) => {
  const { pool } = req.app.locals;
  const email = req.query.email;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  try {
    const account = await getOrCreateTokenAccount(pool, email);
    res.json({
      success: true,
      balance: account.balance,
      total_purchased: account.total_purchased,
      total_won: account.total_won,
      total_lost: account.total_lost,
      net_profit: account.total_won - account.total_lost
    });
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// POST /api/predictions/tokens/purchase
router.post('/tokens/purchase', async (req, res) => {
  const { pool, stripe } = req.app.locals;
  const { packageId, email } = req.body;
  
  if (!email || !packageId) {
    return res.status(400).json({ error: 'Email and packageId required' });
  }
  
  const tokenPackage = TOKEN_PACKAGES[packageId];
  if (!tokenPackage) {
    return res.status(400).json({ error: 'Invalid package' });
  }
  
  try {
    await getOrCreateTokenAccount(pool, email);
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${tokenPackage.name} - ${tokenPackage.tokens} Tokens`,
            description: `${tokenPackage.tokens} prediction tokens for ApeHub`,
          },
          unit_amount: tokenPackage.price_cents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.BASE_URL || req.headers.origin}/predictions.html?purchase=success&tokens=${tokenPackage.tokens}`,
      cancel_url: `${process.env.BASE_URL || req.headers.origin}/predictions.html?purchase=cancelled`,
      customer_email: email,
      metadata: {
        type: 'token_purchase',
        package_id: packageId,
        tokens_amount: tokenPackage.tokens.toString(),
        user_email: email
      }
    });
    
    await pool.query(
      `INSERT INTO token_purchases (user_email, package_name, tokens_amount, price_cents, stripe_checkout_session_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [email, packageId, tokenPackage.tokens, tokenPackage.price_cents, session.id]
    );
    
    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('Error creating checkout:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/predictions/tokens/webhook
router.post('/tokens/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const { pool, stripe } = req.app.locals;
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_TOKENS;
  
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    if (session.metadata?.type === 'token_purchase') {
      const { user_email, tokens_amount } = session.metadata;
      const tokensToAdd = parseInt(tokens_amount);
      
      try {
        await pool.query(
          `UPDATE token_purchases 
           SET status = 'completed', 
               stripe_payment_intent_id = $1,
               completed_at = NOW()
           WHERE stripe_checkout_session_id = $2`,
          [session.payment_intent, session.id]
        );
        
        await pool.query(
          `UPDATE user_tokens 
           SET balance = balance + $1,
               total_purchased = total_purchased + $1
           WHERE user_email = $2`,
          [tokensToAdd, user_email]
        );
        
        console.log(`Added ${tokensToAdd} tokens to ${user_email}`);
      } catch (error) {
        console.error('Error processing token purchase:', error);
      }
    }
  }
  
  res.json({ received: true });
});

// =====================================================
// PREDICTIONS ROUTES
// =====================================================

// GET /api/predictions
router.get('/', async (req, res) => {
  const { pool } = req.app.locals;
  const { category, status = 'open', featured, limit = 50 } = req.query;
  
  try {
    let query = `
      SELECT 
        p.*,
        COALESCE(SUM(CASE WHEN b.position = 'yes' THEN b.tokens_wagered ELSE 0 END), 0)::integer as yes_volume,
        COALESCE(SUM(CASE WHEN b.position = 'no' THEN b.tokens_wagered ELSE 0 END), 0)::integer as no_volume,
        COUNT(DISTINCT b.user_email)::integer as unique_bettors
      FROM predictions p
      LEFT JOIN user_bets b ON p.id = b.prediction_id AND b.status = 'active'
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;
    
    if (status) {
      paramCount++;
      query += ` AND p.status = $${paramCount}`;
      params.push(status);
    }
    
    if (category) {
      paramCount++;
      query += ` AND p.category = $${paramCount}`;
      params.push(category);
    }
    
    if (featured === 'true') {
      query += ` AND p.featured = TRUE`;
    }
    
    query += ` GROUP BY p.id ORDER BY p.featured DESC, p.closes_at ASC`;
    
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(parseInt(limit));
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      predictions: result.rows
    });
  } catch (error) {
    console.error('Error fetching predictions:', error);
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

// GET /api/predictions/:id
router.get('/:id', async (req, res) => {
  const { pool } = req.app.locals;
  const { id } = req.params;
  const { email } = req.query;
  
  try {
    const predictionResult = await pool.query(
      `SELECT 
        p.*,
        COALESCE(SUM(CASE WHEN b.position = 'yes' THEN b.tokens_wagered ELSE 0 END), 0)::integer as yes_volume,
        COALESCE(SUM(CASE WHEN b.position = 'no' THEN b.tokens_wagered ELSE 0 END), 0)::integer as no_volume,
        COUNT(DISTINCT b.user_email)::integer as unique_bettors
      FROM predictions p
      LEFT JOIN user_bets b ON p.id = b.prediction_id AND b.status = 'active'
      WHERE p.id = $1
      GROUP BY p.id`,
      [id]
    );
    
    if (predictionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prediction not found' });
    }
    
    const prediction = predictionResult.rows[0];
    
    let userBet = null;
    if (email) {
      const betResult = await pool.query(
        'SELECT * FROM user_bets WHERE prediction_id = $1 AND user_email = $2',
        [id, email]
      );
      if (betResult.rows.length > 0) {
        userBet = betResult.rows[0];
      }
    }
    
    res.json({
      success: true,
      prediction,
      userBet
    });
  } catch (error) {
    console.error('Error fetching prediction:', error);
    res.status(500).json({ error: 'Failed to fetch prediction' });
  }
});

// =====================================================
// BETTING ROUTES
// =====================================================

// POST /api/predictions/bet
router.post('/bet', async (req, res) => {
  const { pool } = req.app.locals;
  const { email, predictionId, position, amount } = req.body;
  
  if (!email || !predictionId || !position || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (!['yes', 'no'].includes(position)) {
    return res.status(400).json({ error: 'Position must be "yes" or "no"' });
  }
  
  const tokensWagered = parseInt(amount);
  if (isNaN(tokensWagered) || tokensWagered < 1) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const predictionResult = await client.query(
      'SELECT * FROM predictions WHERE id = $1 FOR UPDATE',
      [predictionId]
    );
    
    if (predictionResult.rows.length === 0) {
      throw new Error('Prediction not found');
    }
    
    const prediction = predictionResult.rows[0];
    
    if (prediction.status !== 'open') {
      throw new Error('Betting is closed for this prediction');
    }
    
    if (new Date() > new Date(prediction.closes_at)) {
      throw new Error('Betting period has ended');
    }
    
    if (tokensWagered < prediction.min_bet) {
      throw new Error(`Minimum bet is ${prediction.min_bet} tokens`);
    }
    
    if (tokensWagered > prediction.max_bet) {
      throw new Error(`Maximum bet is ${prediction.max_bet} tokens`);
    }
    
    const existingBet = await client.query(
      'SELECT * FROM user_bets WHERE prediction_id = $1 AND user_email = $2',
      [predictionId, email]
    );
    
    if (existingBet.rows.length > 0) {
      throw new Error('You have already placed a bet on this prediction');
    }
    
    const userResult = await client.query(
      'SELECT * FROM user_tokens WHERE user_email = $1 FOR UPDATE',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error('User account not found. Please purchase tokens first.');
    }
    
    const user = userResult.rows[0];
    
    if (user.balance < tokensWagered) {
      throw new Error(`Insufficient tokens. You have ${user.balance} tokens.`);
    }
    
    const multiplier = position === 'yes' 
      ? parseFloat(prediction.yes_payout_multiplier) 
      : parseFloat(prediction.no_payout_multiplier);
    const potentialPayout = Math.floor(tokensWagered * multiplier);
    
    await client.query(
      'UPDATE user_tokens SET balance = balance - $1 WHERE user_email = $2',
      [tokensWagered, email]
    );
    
    const betResult = await client.query(
      `INSERT INTO user_bets 
        (user_email, prediction_id, position, tokens_wagered, potential_payout, payout_multiplier)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [email, predictionId, position, tokensWagered, potentialPayout, multiplier]
    );
    
    const volumeColumn = position === 'yes' ? 'total_yes_tokens' : 'total_no_tokens';
    await client.query(
      `UPDATE predictions 
       SET ${volumeColumn} = ${volumeColumn} + $1,
           total_bettors = total_bettors + 1
       WHERE id = $2`,
      [tokensWagered, predictionId]
    );
    
    await client.query('COMMIT');
    
    const updatedUser = await pool.query(
      'SELECT balance FROM user_tokens WHERE user_email = $1',
      [email]
    );
    
    res.json({
      success: true,
      bet: betResult.rows[0],
      newBalance: updatedUser.rows[0].balance,
      message: `Bet placed! ${tokensWagered} tokens on ${position.toUpperCase()}. Potential payout: ${potentialPayout} tokens`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error placing bet:', error);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// GET /api/predictions/bets/my
router.get('/bets/my', async (req, res) => {
  const { pool } = req.app.locals;
  const { email, status } = req.query;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  try {
    let query = `
      SELECT 
        b.*,
        p.title as prediction_title,
        p.category,
        p.ticker,
        p.outcome as prediction_outcome,
        p.status as prediction_status,
        p.resolves_at,
        p.closes_at
      FROM user_bets b
      JOIN predictions p ON b.prediction_id = p.id
      WHERE b.user_email = $1
    `;
    const params = [email];
    
    if (status) {
      query += ` AND b.status = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY b.placed_at DESC`;
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      bets: result.rows
    });
  } catch (error) {
    console.error('Error fetching user bets:', error);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// =====================================================
// RESOLUTION ROUTES (Admin)
// =====================================================

// POST /api/predictions/:id/resolve
router.post('/:id/resolve', async (req, res) => {
  const { pool } = req.app.locals;
  const { id } = req.params;
  const { outcome, adminEmail, source } = req.body;
  
  if (!adminEmail) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  
  if (!['yes', 'no'].includes(outcome)) {
    return res.status(400).json({ error: 'Outcome must be "yes" or "no"' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const predictionResult = await client.query(
      'SELECT * FROM predictions WHERE id = $1 FOR UPDATE',
      [id]
    );
    
    if (predictionResult.rows.length === 0) {
      throw new Error('Prediction not found');
    }
    
    const prediction = predictionResult.rows[0];
    
    if (prediction.status === 'resolved') {
      throw new Error('Prediction already resolved');
    }
    
    await client.query(
      `UPDATE predictions 
       SET status = 'resolved',
           outcome = $1,
           resolution_source = $2,
           resolved_at = NOW(),
           resolved_by = $3
       WHERE id = $4`,
      [outcome, source || 'Manual resolution', adminEmail, id]
    );
    
    const betsResult = await client.query(
      'SELECT * FROM user_bets WHERE prediction_id = $1 AND status = \'active\'',
      [id]
    );
    
    for (const bet of betsResult.rows) {
      const won = bet.position === outcome;
      const tokensWon = won ? bet.potential_payout : 0;
      
      await client.query(
        `UPDATE user_bets 
         SET status = $1,
             tokens_won = $2,
             payout_processed = TRUE,
             payout_processed_at = NOW()
         WHERE id = $3`,
        [won ? 'won' : 'lost', tokensWon, bet.id]
      );
      
      if (won) {
        await client.query(
          `UPDATE user_tokens 
           SET balance = balance + $1,
               total_won = total_won + $2
           WHERE user_email = $3`,
          [tokensWon, tokensWon - bet.tokens_wagered, bet.user_email]
        );
      } else {
        await client.query(
          `UPDATE user_tokens 
           SET total_lost = total_lost + $1
           WHERE user_email = $2`,
          [bet.tokens_wagered, bet.user_email]
        );
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: `Prediction resolved as "${outcome}". ${betsResult.rows.length} bets processed.`,
      betsProcessed: betsResult.rows.length
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error resolving prediction:', error);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =====================================================
// PAYOUT ROUTES
// =====================================================

// POST /api/predictions/payout/request
router.post('/payout/request', async (req, res) => {
  const { pool } = req.app.locals;
  const { email, tokensAmount, method, destination } = req.body;
  
  if (!email || !tokensAmount || !method || !destination) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (!['zelle', 'paypal'].includes(method)) {
    return res.status(400).json({ error: 'Method must be "zelle" or "paypal"' });
  }
  
  const tokens = parseInt(tokensAmount);
  if (tokens < MIN_PAYOUT_TOKENS) {
    return res.status(400).json({ error: `Minimum payout is ${MIN_PAYOUT_TOKENS} tokens` });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const userResult = await client.query(
      'SELECT * FROM user_tokens WHERE user_email = $1 FOR UPDATE',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const user = userResult.rows[0];
    
    if (user.balance < tokens) {
      throw new Error(`Insufficient balance. You have ${user.balance} tokens.`);
    }
    
    const usdAmount = (tokens * TOKENS_TO_USD_RATE).toFixed(2);
    
    await client.query(
      'UPDATE user_tokens SET balance = balance - $1 WHERE user_email = $2',
      [tokens, email]
    );
    
    const payoutResult = await client.query(
      `INSERT INTO payout_requests 
        (user_email, tokens_amount, usd_amount, payout_method, payout_destination)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [email, tokens, usdAmount, method, destination]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      payout: payoutResult.rows[0],
      message: `Payout request submitted! ${tokens} tokens = $${usdAmount} via ${method}. We'll process it within 24-48 hours.`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error requesting payout:', error);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// GET /api/predictions/payout/history
router.get('/payout/history', async (req, res) => {
  const { pool } = req.app.locals;
  const { email } = req.query;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM payout_requests WHERE user_email = $1 ORDER BY created_at DESC',
      [email]
    );
    
    res.json({
      success: true,
      payouts: result.rows
    });
  } catch (error) {
    console.error('Error fetching payout history:', error);
    res.status(500).json({ error: 'Failed to fetch payout history' });
  }
});

// =====================================================
// LEADERBOARD
// =====================================================

// GET /api/predictions/leaderboard
router.get('/leaderboard', async (req, res) => {
  const { pool } = req.app.locals;
  const { limit = 20 } = req.query;
  
  try {
    const result = await pool.query(`
      SELECT 
        ut.user_email,
        ut.total_won,
        ut.total_lost,
        (ut.total_won - ut.total_lost) as net_profit,
        COUNT(ub.id)::integer as total_bets,
        COUNT(CASE WHEN ub.status = 'won' THEN 1 END)::integer as wins,
        COUNT(CASE WHEN ub.status = 'lost' THEN 1 END)::integer as losses,
        CASE 
          WHEN COUNT(CASE WHEN ub.status IN ('won', 'lost') THEN 1 END) > 0 
          THEN ROUND(COUNT(CASE WHEN ub.status = 'won' THEN 1 END)::DECIMAL / 
               COUNT(CASE WHEN ub.status IN ('won', 'lost') THEN 1 END) * 100, 1)
          ELSE 0 
        END as win_rate
      FROM user_tokens ut
      LEFT JOIN user_bets ub ON ut.user_email = ub.user_email
      GROUP BY ut.user_email, ut.total_won, ut.total_lost
      HAVING COUNT(CASE WHEN ub.status IN ('won', 'lost') THEN 1 END) > 0
      ORDER BY net_profit DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json({
      success: true,
      leaderboard: result.rows.map((row, index) => ({
        rank: index + 1,
        ...row,
        display_name: row.user_email.split('@')[0].slice(0, 3) + '***'
      }))
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// =====================================================
// ADMIN ROUTES
// =====================================================

// POST /api/predictions/admin/create
router.post('/admin/create', async (req, res) => {
  const { pool } = req.app.locals;
  const {
    adminEmail,
    category,
    subcategory,
    title,
    description,
    ticker,
    parameters,
    yesMultiplier = 2.0,
    noMultiplier = 2.0,
    minBet = 10,
    maxBet = 10000,
    opensAt,
    closesAt,
    resolvesAt,
    featured = false
  } = req.body;
  
  if (!adminEmail) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  
  if (!title || !category || !closesAt || !resolvesAt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO predictions 
        (category, subcategory, title, description, ticker, parameters, 
         yes_payout_multiplier, no_payout_multiplier, min_bet, max_bet,
         opens_at, closes_at, resolves_at, status, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open', $14)
       RETURNING *`,
      [
        category,
        subcategory,
        title,
        description,
        ticker,
        JSON.stringify(parameters || {}),
        yesMultiplier,
        noMultiplier,
        minBet,
        maxBet,
        opensAt || new Date(),
        closesAt,
        resolvesAt,
        featured
      ]
    );
    
    res.json({
      success: true,
      prediction: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating prediction:', error);
    res.status(500).json({ error: 'Failed to create prediction' });
  }
});

// GET /api/predictions/admin/pending-payouts
router.get('/admin/pending-payouts', async (req, res) => {
  const { pool } = req.app.locals;
  
  try {
    const result = await pool.query(
      `SELECT * FROM payout_requests 
       WHERE status = 'pending' 
       ORDER BY created_at ASC`
    );
    
    res.json({
      success: true,
      payouts: result.rows
    });
  } catch (error) {
    console.error('Error fetching pending payouts:', error);
    res.status(500).json({ error: 'Failed to fetch pending payouts' });
  }
});

// POST /api/predictions/admin/process-payout
router.post('/admin/process-payout', async (req, res) => {
  const { pool } = req.app.locals;
  const { payoutId, adminEmail, status, transactionReference, rejectionReason } = req.body;
  
  if (!['approved', 'completed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  try {
    if (status === 'rejected') {
      const payoutResult = await pool.query(
        'SELECT * FROM payout_requests WHERE id = $1',
        [payoutId]
      );
      
      if (payoutResult.rows.length > 0) {
        const payout = payoutResult.rows[0];
        await pool.query(
          'UPDATE user_tokens SET balance = balance + $1 WHERE user_email = $2',
          [payout.tokens_amount, payout.user_email]
        );
      }
    }
    
    await pool.query(
      `UPDATE payout_requests 
       SET status = $1, 
           reviewed_by = $2, 
           reviewed_at = NOW(),
           transaction_reference = $3,
           rejection_reason = $4,
           completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
       WHERE id = $5`,
      [status, adminEmail, transactionReference, rejectionReason, payoutId]
    );
    
    res.json({
      success: true,
      message: `Payout ${status}`
    });
  } catch (error) {
    console.error('Error processing payout:', error);
    res.status(500).json({ error: 'Failed to process payout' });
  }
});

module.exports = router;
