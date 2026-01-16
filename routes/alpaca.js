// Alpaca Market Data API Routes
const express = require('express');
const router = express.Router();

const ALPACA_API_KEY = process.env.ALPACA_API_KEY || 'AKZ3OS3PVBQ2WGEAVNF2MVSYV5';
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || '5HFdsA4Zj19zUnzgM35qGWKpqHLix3QLj23maxoXbuf8';
const ALPACA_DATA_URL = 'https://data.alpaca.markets';

// Helper to make Alpaca API requests
async function alpacaFetch(endpoint) {
  const response = await fetch(`${ALPACA_DATA_URL}${endpoint}`, {
    headers: {
      'APCA-API-KEY-ID': ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY
    }
  });
  if (!response.ok) {
    throw new Error(`Alpaca API error: ${response.status}`);
  }
  return response.json();
}

// GET /api/market/quote/:symbol - Get latest quote for a symbol
router.get('/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await alpacaFetch(`/v2/stocks/${symbol}/quotes/latest`);
    res.json({
      success: true,
      symbol,
      quote: data.quote
    });
  } catch (error) {
    console.error('Error fetching quote:', error);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// GET /api/market/trade/:symbol - Get latest trade for a symbol
router.get('/trade/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await alpacaFetch(`/v2/stocks/${symbol}/trades/latest`);
    res.json({
      success: true,
      symbol,
      trade: data.trade
    });
  } catch (error) {
    console.error('Error fetching trade:', error);
    res.status(500).json({ error: 'Failed to fetch trade' });
  }
});

// GET /api/market/bar/:symbol - Get daily bar (open, high, low, close)
router.get('/bar/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await alpacaFetch(`/v2/stocks/${symbol}/bars/latest`);
    res.json({
      success: true,
      symbol,
      bar: data.bar
    });
  } catch (error) {
    console.error('Error fetching bar:', error);
    res.status(500).json({ error: 'Failed to fetch bar' });
  }
});

// GET /api/market/snapshot/:symbol - Get full snapshot (quote, trade, bar)
router.get('/snapshot/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await alpacaFetch(`/v2/stocks/${symbol}/snapshot`);
    
    const snapshot = data;
    const prevClose = snapshot.prevDailyBar?.c || snapshot.dailyBar?.o;
    const currentPrice = snapshot.latestTrade?.p || snapshot.latestQuote?.ap;
    const change = currentPrice && prevClose ? currentPrice - prevClose : 0;
    const changePercent = prevClose ? ((change / prevClose) * 100) : 0;
    
    res.json({
      success: true,
      symbol,
      price: currentPrice,
      prevClose,
      change: change.toFixed(2),
      changePercent: changePercent.toFixed(2),
      isGreen: change >= 0,
      dailyBar: snapshot.dailyBar,
      prevDailyBar: snapshot.prevDailyBar,
      latestTrade: snapshot.latestTrade,
      latestQuote: snapshot.latestQuote
    });
  } catch (error) {
    console.error('Error fetching snapshot:', error);
    res.status(500).json({ error: 'Failed to fetch snapshot' });
  }
});

// GET /api/market/snapshots - Get snapshots for multiple symbols
router.get('/snapshots', async (req, res) => {
  try {
    const symbols = req.query.symbols?.split(',').map(s => s.toUpperCase()).join(',');
    if (!symbols) {
      return res.status(400).json({ error: 'symbols parameter required' });
    }
    
    const data = await alpacaFetch(`/v2/stocks/snapshots?symbols=${symbols}`);
    
    const results = {};
    for (const [symbol, snapshot] of Object.entries(data)) {
      const prevClose = snapshot.prevDailyBar?.c || snapshot.dailyBar?.o;
      const currentPrice = snapshot.latestTrade?.p || snapshot.latestQuote?.ap;
      const change = currentPrice && prevClose ? currentPrice - prevClose : 0;
      const changePercent = prevClose ? ((change / prevClose) * 100) : 0;
      
      results[symbol] = {
        price: currentPrice,
        prevClose,
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        isGreen: change >= 0,
        dailyBar: snapshot.dailyBar,
        prevDailyBar: snapshot.prevDailyBar
      };
    }
    
    res.json({
      success: true,
      snapshots: results
    });
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
});

// GET /api/market/check-green/:symbol - Check if stock closed green (for auto-resolution)
router.get('/check-green/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await alpacaFetch(`/v2/stocks/${symbol}/snapshot`);
    
    const snapshot = data;
    const todayOpen = snapshot.dailyBar?.o;
    const todayClose = snapshot.dailyBar?.c;
    const prevClose = snapshot.prevDailyBar?.c;
    
    // Stock closed green if close > open (for daily predictions)
    const closedGreen = todayClose > todayOpen;
    // Or if using prev close: todayClose > prevClose
    const upFromPrevClose = todayClose > prevClose;
    
    res.json({
      success: true,
      symbol,
      todayOpen,
      todayClose,
      prevClose,
      closedGreen,           // Today's close > today's open
      upFromPrevClose,       // Today's close > yesterday's close
      changePercent: prevClose ? (((todayClose - prevClose) / prevClose) * 100).toFixed(2) : 0
    });
  } catch (error) {
    console.error('Error checking green:', error);
    res.status(500).json({ error: 'Failed to check if stock closed green' });
  }
});

module.exports = router;
