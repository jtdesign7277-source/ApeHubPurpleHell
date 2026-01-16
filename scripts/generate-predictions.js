// =====================================================
// DAILY PREDICTIONS GENERATOR
// Run this as a cron job every night at 8pm ET
// Creates next trading day's predictions automatically
// =====================================================

const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// =====================================================
// CONFIGURATION
// =====================================================

// Tickers to create daily "close green" predictions for
const DAILY_TICKERS = [
  { ticker: 'TSLA', name: 'Tesla', featured: true },
  { ticker: 'NVDA', name: 'NVIDIA', featured: true },
  { ticker: 'AAPL', name: 'Apple', featured: false },
  { ticker: 'SPY', name: 'S&P 500 ETF', featured: true },
  { ticker: 'QQQ', name: 'NASDAQ ETF', featured: false },
  { ticker: 'AMZN', name: 'Amazon', featured: false },
  { ticker: 'GOOGL', name: 'Google', featured: false },
  { ticker: 'META', name: 'Meta', featured: false },
  { ticker: 'MSFT', name: 'Microsoft', featured: false },
  { ticker: 'AMD', name: 'AMD', featured: true },
];

// Weekly predictions (created on Sunday night for the week)
const WEEKLY_TICKERS = [
  { ticker: 'NVDA', range: 5, featured: true },
  { ticker: 'TSLA', range: 7, featured: true },
  { ticker: 'QQQ', range: 3, featured: false },
  { ticker: 'SPY', range: 2, featured: false },
];

// Default odds (slight house edge)
const DEFAULT_YES_MULTIPLIER = 1.90;
const DEFAULT_NO_MULTIPLIER = 1.90;

// =====================================================
// TRADING CALENDAR HELPERS
// =====================================================

// US Market holidays 2025
const MARKET_HOLIDAYS_2025 = [
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
];

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function isHoliday(date) {
  const dateStr = date.toISOString().split('T')[0];
  return MARKET_HOLIDAYS_2025.includes(dateStr);
}

function isTradingDay(date) {
  return !isWeekend(date) && !isHoliday(date);
}

function getNextTradingDay(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setDate(next.getDate() + 1);
  
  while (!isTradingDay(next)) {
    next.setDate(next.getDate() + 1);
  }
  
  return next;
}

function getFridayOfWeek(date) {
  const friday = new Date(date);
  const day = friday.getDay();
  const diff = 5 - day;
  friday.setDate(friday.getDate() + diff);
  return friday;
}

// =====================================================
// TIME HELPERS (ET timezone)
// =====================================================

function createDailyTimes(tradingDate) {
  // Opens: 8pm ET the night before
  const opensAt = new Date(tradingDate);
  opensAt.setDate(opensAt.getDate() - 1);
  opensAt.setHours(20, 0, 0, 0);
  
  // Closes: 9:30am ET (market open)
  const closesAt = new Date(tradingDate);
  closesAt.setHours(9, 30, 0, 0);
  
  // Resolves: 4:30pm ET (after market close)
  const resolvesAt = new Date(tradingDate);
  resolvesAt.setHours(16, 30, 0, 0);
  
  return { opensAt, closesAt, resolvesAt };
}

function createWeeklyTimes(mondayDate) {
  // Opens: Sunday 8pm ET
  const opensAt = new Date(mondayDate);
  opensAt.setDate(opensAt.getDate() - 1);
  opensAt.setHours(20, 0, 0, 0);
  
  // Closes: Monday 9:30am ET
  const closesAt = new Date(mondayDate);
  closesAt.setHours(9, 30, 0, 0);
  
  // Resolves: Friday 4:30pm ET
  const friday = getFridayOfWeek(mondayDate);
  const resolvesAt = new Date(friday);
  resolvesAt.setHours(16, 30, 0, 0);
  
  return { opensAt, closesAt, resolvesAt };
}

// =====================================================
// PREDICTION GENERATORS
// =====================================================

async function createDailyPrediction(ticker, name, tradingDate, featured = false) {
  const { opensAt, closesAt, resolvesAt } = createDailyTimes(tradingDate);
  
  const dateStr = tradingDate.toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'short', 
    day: 'numeric' 
  });
  
  const title = `Will ${ticker} close green today?`;
  const description = `Predict whether ${name} (${ticker}) will close higher than its opening price on ${dateStr}. Betting closes at market open (9:30am ET).`;
  
  try {
    // Check if prediction already exists
    const existing = await pool.query(
      `SELECT id FROM predictions 
       WHERE ticker = $1 
       AND DATE(resolves_at) = DATE($2)
       AND category = 'daily'
       AND subcategory = 'close_green'`,
      [ticker, resolvesAt]
    );
    
    if (existing.rows.length > 0) {
      console.log(`⏭️  Skipping ${ticker} - prediction already exists for ${dateStr}`);
      return null;
    }
    
    const result = await pool.query(
      `INSERT INTO predictions 
        (category, subcategory, title, description, ticker, parameters,
         yes_payout_multiplier, no_payout_multiplier, min_bet, max_bet,
         opens_at, closes_at, resolves_at, status, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, title`,
      [
        'daily',
        'close_green',
        title,
        description,
        ticker,
        JSON.stringify({ type: 'close_green', ticker }),
        DEFAULT_YES_MULTIPLIER,
        DEFAULT_NO_MULTIPLIER,
        10,
        10000,
        opensAt,
        closesAt,
        resolvesAt,
        'upcoming',
        featured
      ]
    );
    
    console.log(`✅ Created: ${result.rows[0].title} (ID: ${result.rows[0].id})`);
    return result.rows[0];
    
  } catch (error) {
    console.error(`❌ Error creating prediction for ${ticker}:`, error.message);
    return null;
  }
}

async function createWeeklyRangePrediction(ticker, rangePct, mondayDate, featured = false) {
  const { opensAt, closesAt, resolvesAt } = createWeeklyTimes(mondayDate);
  
  const weekStr = mondayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fridayStr = getFridayOfWeek(mondayDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  
  const title = `Will ${ticker} move ±${rangePct}% this week?`;
  const description = `Predict whether ${ticker} will have a weekly range of at least ${rangePct}% in either direction from Monday open to Friday close (${weekStr} - ${fridayStr}).`;
  
  try {
    const existing = await pool.query(
      `SELECT id FROM predictions 
       WHERE ticker = $1 
       AND DATE(resolves_at) = DATE($2)
       AND category = 'weekly'`,
      [ticker, resolvesAt]
    );
    
    if (existing.rows.length > 0) {
      console.log(`⏭️  Skipping weekly ${ticker} - already exists`);
      return null;
    }
    
    const yesMultiplier = rangePct >= 5 ? 2.20 : 2.00;
    const noMultiplier = rangePct >= 5 ? 1.80 : 1.90;
    
    const result = await pool.query(
      `INSERT INTO predictions 
        (category, subcategory, title, description, ticker, parameters,
         yes_payout_multiplier, no_payout_multiplier, min_bet, max_bet,
         opens_at, closes_at, resolves_at, status, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, title`,
      [
        'weekly',
        'range',
        title,
        description,
        ticker,
        JSON.stringify({ type: 'weekly_range', ticker, range_pct: rangePct }),
        yesMultiplier,
        noMultiplier,
        10,
        10000,
        opensAt,
        closesAt,
        resolvesAt,
        'upcoming',
        featured
      ]
    );
    
    console.log(`✅ Created weekly: ${result.rows[0].title}`);
    return result.rows[0];
    
  } catch (error) {
    console.error(`❌ Error creating weekly prediction for ${ticker}:`, error.message);
    return null;
  }
}

// =====================================================
// MAIN GENERATION FUNCTIONS
// =====================================================

async function generateDailyPredictions() {
  console.log('\n📈 Generating daily predictions...\n');
  
  const nextTradingDay = getNextTradingDay();
  console.log(`Next trading day: ${nextTradingDay.toDateString()}\n`);
  
  let created = 0;
  let skipped = 0;
  
  for (const { ticker, name, featured } of DAILY_TICKERS) {
    const result = await createDailyPrediction(ticker, name, nextTradingDay, featured);
    if (result) created++;
    else skipped++;
  }
  
  console.log(`\n✨ Daily predictions: ${created} created, ${skipped} skipped\n`);
  return { created, skipped };
}

async function generateWeeklyPredictions() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  
  // Only generate weekly predictions on Sunday (0)
  if (dayOfWeek !== 0) {
    console.log('⏭️  Skipping weekly predictions (not Sunday)');
    return { created: 0, skipped: 0 };
  }
  
  console.log('\n📊 Generating weekly predictions...\n');
  
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + 1);
  
  let created = 0;
  let skipped = 0;
  
  for (const { ticker, range, featured } of WEEKLY_TICKERS) {
    const result = await createWeeklyRangePrediction(ticker, range, nextMonday, featured);
    if (result) created++;
    else skipped++;
  }
  
  console.log(`\n✨ Weekly predictions: ${created} created, ${skipped} skipped\n`);
  return { created, skipped };
}

async function updatePredictionStatuses() {
  console.log('\n🔄 Updating prediction statuses...\n');
  
  const now = new Date();
  
  // Open predictions that should be open
  const opened = await pool.query(
    `UPDATE predictions 
     SET status = 'open' 
     WHERE status = 'upcoming' 
     AND opens_at <= $1 
     AND closes_at > $1
     RETURNING id, title`,
    [now]
  );
  
  if (opened.rows.length > 0) {
    console.log(`🟢 Opened ${opened.rows.length} predictions:`);
    opened.rows.forEach(p => console.log(`   - ${p.title}`));
  }
  
  // Close predictions that should be closed
  const closed = await pool.query(
    `UPDATE predictions 
     SET status = 'closed' 
     WHERE status = 'open' 
     AND closes_at <= $1
     RETURNING id, title`,
    [now]
  );
  
  if (closed.rows.length > 0) {
    console.log(`🔴 Closed ${closed.rows.length} predictions:`);
    closed.rows.forEach(p => console.log(`   - ${p.title}`));
  }
  
  return { opened: opened.rows.length, closed: closed.rows.length };
}

// =====================================================
// MAIN ENTRY POINT
// =====================================================

async function runDailyGeneration() {
  console.log('═'.repeat(50));
  console.log('🌙 DAILY PREDICTIONS GENERATOR');
  console.log(`   Running at: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
  console.log('═'.repeat(50));
  
  try {
    await updatePredictionStatuses();
    const daily = await generateDailyPredictions();
    const weekly = await generateWeeklyPredictions();
    
    console.log('═'.repeat(50));
    console.log('✅ GENERATION COMPLETE');
    console.log(`   Daily: ${daily.created} new, ${daily.skipped} skipped`);
    console.log(`   Weekly: ${weekly.created} new, ${weekly.skipped} skipped`);
    console.log('═'.repeat(50));
    
    return { success: true, daily, weekly };
    
  } catch (error) {
    console.error('❌ Generation failed:', error);
    return { success: false, error: error.message };
  }
}

// =====================================================
// EXPRESS ENDPOINT (Alternative to cron)
// =====================================================

async function handleGenerateRequest(req, res) {
  const { adminEmail } = req.body;
  
  if (!adminEmail) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  
  const result = await runDailyGeneration();
  res.json(result);
}

// =====================================================
// RUN IF EXECUTED DIRECTLY
// =====================================================

if (require.main === module) {
  runDailyGeneration()
    .then(() => {
      console.log('\n👋 Done! Exiting...\n');
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

module.exports = {
  runDailyGeneration,
  generateDailyPredictions,
  generateWeeklyPredictions,
  updatePredictionStatuses,
  handleGenerateRequest,
  getNextTradingDay,
  isTradingDay
};
