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
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    const data = await kalshiRequest('GET', '/markets?status=open&limit=50');
    
    // Transform Kalshi markets to our format
    const markets = data.markets?.map(m => ({
      id: m.ticker,
      title: m.title,
      subtitle: m.subtitle,
      category: m.category || 'general',
      yesPrice: m.yes_ask ? m.yes_ask / 100 : 0.5,
      noPrice: m.no_ask ? m.no_ask / 100 : 0.5,
      yesBid: m.yes_bid ? m.yes_bid / 100 : 0.5,
      noBid: m.no_bid ? m.no_bid / 100 : 0.5,
      volume: m.volume || 0,
      openInterest: m.open_interest || 0,
      closeTime: m.close_time,
      expirationTime: m.expiration_time,
      status: m.status,
      result: m.result
    })) || [];
    
    // Cache the results
    marketsCache = markets;
    marketsCacheTime = now;
    
    res.json({ success: true, markets, cached: false });
  } catch (error) {
    console.error('Error fetching Kalshi markets:', error);
    res.status(500).json({ error: 'Failed to fetch markets', details: error.message });
  }
});

// GET /api/kalshi/markets/:ticker - Get specific market
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

module.exports = router;
