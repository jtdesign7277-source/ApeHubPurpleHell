const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Kalshi API Configuration
const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_API_KEY = process.env.KALSHI_API_KEY;
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY;

// Generate signature for Kalshi API requests
function signRequest(timestamp, method, path) {
  if (!KALSHI_PRIVATE_KEY) {
    throw new Error('Kalshi private key not configured');
  }
  
  const message = `${timestamp}${method}${path}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  
  // Handle the private key (may need to replace escaped newlines)
  const privateKey = KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n');
  const signature = sign.sign(privateKey, 'base64');
  
  return signature;
}

// Make authenticated request to Kalshi API
async function kalshiRequest(method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signRequest(timestamp, method, path);
  
  const headers = {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp
  };
  
  const options = {
    method,
    headers
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`${KALSHI_API_BASE}${path}`, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Kalshi API error:', response.status, errorText);
    throw new Error(`Kalshi API error: ${response.status}`);
  }
  
  return response.json();
}

// Cache for markets (5 minute TTL)
let marketsCache = null;
let marketsCacheTime = 0;
let eventMarketsCache = {}; // Cache markets by event ticker
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper to transform Kalshi market to our format
function transformKalshiMarket(m) {
  // Calculate yes/no prices from the market data
  const yesPrice = m.yes_ask ? m.yes_ask / 100 : (m.last_price ? m.last_price / 100 : 0.5);
  const noPrice = 1 - yesPrice;
  
  // Calculate multipliers (payout = 1/price)
  const yesMultiplier = yesPrice > 0 ? (1 / yesPrice).toFixed(2) : 2.00;
  const noMultiplier = noPrice > 0 ? (1 / noPrice).toFixed(2) : 2.00;
  
  return {
    id: m.ticker,
    kalshi_ticker: m.ticker,
    event_ticker: m.event_ticker,
    title: m.title || m.subtitle || m.ticker,
    subtitle: m.subtitle,
    category: 'kalshi',
    yesPrice: yesPrice,
    noPrice: noPrice,
    yes_payout_multiplier: parseFloat(yesMultiplier),
    no_payout_multiplier: parseFloat(noMultiplier),
    yesProbability: Math.round(yesPrice * 100),
    noProbability: Math.round(noPrice * 100),
    volume: m.volume || 0,
    openInterest: m.open_interest || 0,
    closes_at: m.close_time,
    expiration_time: m.expiration_time,
    status: m.status,
    result: m.result,
    yes_volume: m.volume_yes || 0,
    no_volume: m.volume_no || 0,
    total_bettors: 0, // We track this separately
    min_bet: 10,
    max_bet: 10000,
    is_kalshi: true
  };
}

// GET /api/kalshi/markets - Fetch active markets
router.get('/markets', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if fresh
    if (marketsCache && (now - marketsCacheTime) < CACHE_TTL) {
      return res.json({ success: true, markets: marketsCache, cached: true });
    }
    
    // Fetch markets from Kalshi
    // Filter by status=open and limit results
    const data = await kalshiRequest('GET', '/markets?status=open&limit=100');
    
    // Transform Kalshi markets to our format
    const markets = data.markets?.map(transformKalshiMarket) || [];
    
    // Cache the results
    marketsCache = markets;
    marketsCacheTime = now;
    
    res.json({ success: true, markets, cached: false });
  } catch (error) {
    console.error('Error fetching Kalshi markets:', error);
    res.status(500).json({ error: 'Failed to fetch markets', details: error.message });
  }
});

// GET /api/kalshi/event/:eventTicker/markets - Get all markets for a specific event
router.get('/event/:eventTicker/markets', async (req, res) => {
  try {
    const { eventTicker } = req.params;
    const now = Date.now();
    
    // Check cache
    if (eventMarketsCache[eventTicker] && (now - eventMarketsCache[eventTicker].time) < CACHE_TTL) {
      return res.json({ 
        success: true, 
        markets: eventMarketsCache[eventTicker].markets,
        event: eventMarketsCache[eventTicker].event,
        cached: true 
      });
    }
    
    // Fetch the event details
    const eventData = await kalshiRequest('GET', `/events/${eventTicker}`);
    
    // Fetch markets for this event
    const marketsData = await kalshiRequest('GET', `/markets?event_ticker=${eventTicker}&limit=50`);
    
    const markets = marketsData.markets?.map(transformKalshiMarket) || [];
    
    // Cache the results
    eventMarketsCache[eventTicker] = {
      markets,
      event: eventData.event,
      time: now
    };
    
    res.json({ 
      success: true, 
      markets,
      event: eventData.event,
      cached: false 
    });
  } catch (error) {
    console.error('Error fetching event markets:', error);
    res.status(500).json({ error: 'Failed to fetch event markets', details: error.message });
  }
});

// GET /api/kalshi/market/:ticker - Get specific market with current odds
router.get('/market/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const data = await kalshiRequest('GET', `/markets/${ticker}`);
    
    if (!data.market) {
      return res.status(404).json({ error: 'Market not found' });
    }
    
    const market = transformKalshiMarket(data.market);
    
    res.json({ success: true, market });
  } catch (error) {
    console.error('Error fetching Kalshi market:', error);
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

// GET /api/kalshi/markets/:ticker - Get specific market (legacy route)
router.get('/markets/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const data = await kalshiRequest('GET', `/markets/${ticker}`);
    
    res.json({ success: true, market: data.market });
  } catch (error) {
    console.error('Error fetching Kalshi market:', error);
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

// GET /api/kalshi/events - Fetch events (groups of related markets)
router.get('/events', async (req, res) => {
  try {
    const { series_ticker, status = 'open', limit = 20 } = req.query;
    
    let path = `/events?status=${status}&limit=${limit}`;
    if (series_ticker) {
      path += `&series_ticker=${series_ticker}`;
    }
    
    const data = await kalshiRequest('GET', path);
    
    res.json({ success: true, events: data.events || [] });
  } catch (error) {
    console.error('Error fetching Kalshi events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/kalshi/series - Fetch market series (e.g., "Fed Rate Decisions")
router.get('/series', async (req, res) => {
  try {
    const data = await kalshiRequest('GET', '/series');
    
    res.json({ success: true, series: data.series || [] });
  } catch (error) {
    console.error('Error fetching Kalshi series:', error);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// GET /api/kalshi/orderbook/:ticker - Get orderbook for a market
router.get('/orderbook/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const data = await kalshiRequest('GET', `/markets/${ticker}/orderbook`);
    
    res.json({ success: true, orderbook: data.orderbook });
  } catch (error) {
    console.error('Error fetching orderbook:', error);
    res.status(500).json({ error: 'Failed to fetch orderbook' });
  }
});

// =====================================================
// KALSHI BETTING - Uses our token system
// =====================================================

// Store for Kalshi bets (maps kalshi ticker to our internal tracking)
// In production, this would be in the database

// POST /api/kalshi/bet - Place a bet on a Kalshi market using tokens
router.post('/bet', async (req, res) => {
  const { pool } = req.app.locals;
  const { email, marketTicker, position, amount } = req.body;
  
  if (!email || !marketTicker || !position || !amount) {
    return res.status(400).json({ error: 'Missing required fields: email, marketTicker, position, amount' });
  }
  
  if (!['yes', 'no'].includes(position)) {
    return res.status(400).json({ error: 'Position must be "yes" or "no"' });
  }
  
  const tokensWagered = parseInt(amount);
  if (isNaN(tokensWagered) || tokensWagered < 10) {
    return res.status(400).json({ error: 'Minimum bet is 10 tokens' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Fetch current market data from Kalshi to get live odds
    const marketData = await kalshiRequest('GET', `/markets/${marketTicker}`);
    const market = marketData.market;
    
    if (!market) {
      throw new Error('Market not found on Kalshi');
    }
    
    // Accept both 'open' and 'active' as valid statuses
    if (!['open', 'active'].includes(market.status)) {
      throw new Error(`This market is no longer open for betting (status: ${market.status})`);
    }
    
    // Ensure kalshi_bets table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_bets (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(255) NOT NULL,
        kalshi_ticker VARCHAR(255) NOT NULL,
        event_ticker VARCHAR(255),
        market_title TEXT,
        position VARCHAR(10) NOT NULL,
        tokens_wagered INTEGER NOT NULL,
        potential_payout INTEGER NOT NULL,
        payout_multiplier DECIMAL(10,2) NOT NULL,
        kalshi_status VARCHAR(50) DEFAULT 'active',
        status VARCHAR(50) DEFAULT 'active',
        result VARCHAR(50),
        tokens_won INTEGER DEFAULT 0,
        placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP,
        UNIQUE(user_email, kalshi_ticker)
      )
    `);
    
    // Ensure tokens_won column exists (for tables created before this update)
    await client.query(`
      ALTER TABLE kalshi_bets ADD COLUMN IF NOT EXISTS tokens_won INTEGER DEFAULT 0
    `).catch(() => {});
    
    // Calculate odds based on current Kalshi prices
    const yesPrice = market.yes_ask ? market.yes_ask / 100 : 0.5;
    const noPrice = 1 - yesPrice;
    const multiplier = position === 'yes' 
      ? (yesPrice > 0 ? 1 / yesPrice : 2)
      : (noPrice > 0 ? 1 / noPrice : 2);
    
    // Check user balance
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
    
    // Check if user already bet on this market
    const existingBet = await client.query(
      'SELECT * FROM kalshi_bets WHERE kalshi_ticker = $1 AND user_email = $2',
      [marketTicker, email]
    );
    
    if (existingBet.rows.length > 0) {
      throw new Error('You have already placed a bet on this market');
    }
    
    const potentialPayout = Math.floor(tokensWagered * multiplier);
    
    // Deduct tokens from user
    await client.query(
      'UPDATE user_tokens SET balance = balance - $1 WHERE user_email = $2',
      [tokensWagered, email]
    );
    
    // Record the Kalshi bet
    const betResult = await client.query(
      `INSERT INTO kalshi_bets 
        (user_email, kalshi_ticker, event_ticker, market_title, position, tokens_wagered, potential_payout, payout_multiplier, kalshi_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [email, marketTicker, market.event_ticker, market.title, position, tokensWagered, potentialPayout, multiplier.toFixed(2), market.status]
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
      message: `Bet placed! ${tokensWagered} tokens on ${position.toUpperCase()} at ${multiplier.toFixed(2)}x. Potential payout: ${potentialPayout} tokens`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error placing Kalshi bet:', error);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// GET /api/kalshi/bets/my - Get user's Kalshi bets
router.get('/bets/my', async (req, res) => {
  const { pool } = req.app.locals;
  const { email, status } = req.query;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  try {
    // Check if table exists first
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'kalshi_bets'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      // Table doesn't exist yet, return empty array
      return res.json({ success: true, bets: [] });
    }
    
    let query = `
      SELECT * FROM kalshi_bets 
      WHERE user_email = $1
    `;
    const params = [email];
    
    if (status) {
      query += ` AND status = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY placed_at DESC`;
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      bets: result.rows
    });
  } catch (error) {
    console.error('Error fetching Kalshi bets:', error);
    // Return empty array on error to not block the UI
    res.json({ success: true, bets: [] });
  }
});

// POST /api/kalshi/sync-resolutions - Sync resolved markets and payout winners
router.post('/sync-resolutions', async (req, res) => {
  const { pool } = req.app.locals;
  
  try {
    // Get all active Kalshi bets
    const activeBets = await pool.query(
      `SELECT DISTINCT kalshi_ticker FROM kalshi_bets WHERE status = 'active'`
    );
    
    if (activeBets.rows.length === 0) {
      return res.json({ success: true, message: 'No active bets to sync', resolved: 0 });
    }
    
    let resolvedCount = 0;
    let payoutTotal = 0;
    
    for (const row of activeBets.rows) {
      const ticker = row.kalshi_ticker;
      
      try {
        // Fetch current market status from Kalshi
        const marketData = await kalshiRequest('GET', `/markets/${ticker}`);
        const market = marketData.market;
        
        if (!market) continue;
        
        // Check if market is settled/finalized
        if (market.status === 'finalized' || market.result) {
          const outcome = market.result; // 'yes', 'no', or null
          
          if (outcome) {
            // Get all bets on this market
            const bets = await pool.query(
              `SELECT * FROM kalshi_bets WHERE kalshi_ticker = $1 AND status = 'active'`,
              [ticker]
            );
            
            for (const bet of bets.rows) {
              const won = bet.position === outcome;
              const tokensWon = won ? bet.potential_payout : 0;
              const newStatus = won ? 'won' : 'lost';
              
              // Update bet status
              await pool.query(
                `UPDATE kalshi_bets 
                 SET status = $1, tokens_won = $2, kalshi_status = 'finalized', resolved_at = NOW()
                 WHERE id = $3`,
                [newStatus, tokensWon, bet.id]
              );
              
              // If won, credit tokens to user
              if (won) {
                await pool.query(
                  `UPDATE user_tokens 
                   SET balance = balance + $1, total_won = total_won + $1
                   WHERE user_email = $2`,
                  [tokensWon, bet.user_email]
                );
                payoutTotal += tokensWon;
              } else {
                // Update total lost
                await pool.query(
                  `UPDATE user_tokens 
                   SET total_lost = total_lost + $1
                   WHERE user_email = $2`,
                  [bet.tokens_wagered, bet.user_email]
                );
              }
              
              resolvedCount++;
            }
          }
        }
      } catch (err) {
        console.error(`Error syncing market ${ticker}:`, err.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: `Synced ${resolvedCount} bets, paid out ${payoutTotal} tokens`,
      resolved: resolvedCount,
      payoutTotal
    });
    
  } catch (error) {
    console.error('Error syncing Kalshi resolutions:', error);
    res.status(500).json({ error: 'Failed to sync resolutions' });
  }
});

module.exports = router;
