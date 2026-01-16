// Seed script for predictions database
// Run with: node scripts/seed-predictions.js

const { Pool } = require('pg');

// Use Railway DATABASE_URL directly
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:FMRmMluVUYlwnqQwjaqipoIDFzcfLNNi@switchyard.proxy.rlwy.net:11552/railway',
  ssl: { rejectUnauthorized: false }
});

async function seedPredictions() {
  const client = await pool.connect();
  
  try {
    console.log('🌱 Seeding predictions database...\n');
    
    // Clear existing predictions (optional - comment out to keep existing)
    // await client.query('DELETE FROM predictions');
    // console.log('Cleared existing predictions');
    
    const predictions = [
      // ===== DAILY PREDICTIONS =====
      {
        title: 'SPY will close green today',
        category: 'daily',
        ticker: 'SPY',
        yes_payout: 1.95,
        no_payout: 1.95,
        resolves_at: getNextMarketClose(),
        featured: true
      },
      {
        title: 'NVDA will hit $150 today',
        category: 'daily',
        ticker: 'NVDA',
        yes_payout: 2.40,
        no_payout: 1.65,
        resolves_at: getNextMarketClose(),
        featured: false
      },
      {
        title: 'TSLA will move 3%+ in either direction',
        category: 'daily',
        ticker: 'TSLA',
        yes_payout: 1.80,
        no_payout: 2.10,
        resolves_at: getNextMarketClose(),
        featured: false
      },
      {
        title: 'AAPL will outperform MSFT today',
        category: 'daily',
        ticker: 'AAPL',
        yes_payout: 2.00,
        no_payout: 1.90,
        resolves_at: getNextMarketClose(),
        featured: false
      },
      {
        title: 'VIX will close above 18',
        category: 'daily',
        ticker: 'VIX',
        yes_payout: 2.25,
        no_payout: 1.70,
        resolves_at: getNextMarketClose(),
        featured: false
      },
      
      // ===== WEEKLY PREDICTIONS =====
      {
        title: 'S&P 500 will finish the week positive',
        category: 'weekly',
        ticker: 'SPY',
        yes_payout: 1.85,
        no_payout: 2.05,
        resolves_at: getNextFriday(),
        featured: true
      },
      {
        title: 'META will hit all-time high this week',
        category: 'weekly',
        ticker: 'META',
        yes_payout: 2.60,
        no_payout: 1.55,
        resolves_at: getNextFriday(),
        featured: false
      },
      {
        title: 'AMD will close above $180 by Friday',
        category: 'weekly',
        ticker: 'AMD',
        yes_payout: 2.15,
        no_payout: 1.80,
        resolves_at: getNextFriday(),
        featured: false
      },
      {
        title: 'Oil (WTI) will break $80/barrel this week',
        category: 'weekly',
        ticker: 'OIL',
        yes_payout: 1.90,
        no_payout: 2.00,
        resolves_at: getNextFriday(),
        featured: false
      },
      {
        title: 'Russell 2000 outperforms Nasdaq this week',
        category: 'weekly',
        ticker: 'IWM',
        yes_payout: 2.30,
        no_payout: 1.70,
        resolves_at: getNextFriday(),
        featured: false
      },
      
      // ===== CRYPTO PREDICTIONS =====
      {
        title: 'Bitcoin will hit $120,000 this month',
        category: 'crypto',
        ticker: 'BTC',
        yes_payout: 2.10,
        no_payout: 1.85,
        resolves_at: getEndOfMonth(),
        featured: true
      },
      {
        title: 'Ethereum will flip $4,000 this week',
        category: 'crypto',
        ticker: 'ETH',
        yes_payout: 1.75,
        no_payout: 2.20,
        resolves_at: getNextFriday(),
        featured: false
      },
      {
        title: 'SOL will outperform ETH this week',
        category: 'crypto',
        ticker: 'SOL',
        yes_payout: 2.00,
        no_payout: 1.90,
        resolves_at: getNextFriday(),
        featured: false
      },
      {
        title: 'Total crypto market cap hits $4T this month',
        category: 'crypto',
        ticker: 'TOTAL',
        yes_payout: 2.45,
        no_payout: 1.60,
        resolves_at: getEndOfMonth(),
        featured: false
      },
      {
        title: 'Dogecoin will pump 20%+ this week',
        category: 'crypto',
        ticker: 'DOGE',
        yes_payout: 3.20,
        no_payout: 1.40,
        resolves_at: getNextFriday(),
        featured: false
      },
      
      // ===== EVENTS PREDICTIONS =====
      {
        title: 'Fed will cut rates at next FOMC meeting',
        category: 'events',
        ticker: 'FED',
        yes_payout: 1.65,
        no_payout: 2.35,
        resolves_at: new Date('2026-01-29T19:00:00Z'),
        featured: true
      },
      {
        title: 'Super Bowl LX will have 115M+ viewers',
        category: 'events',
        ticker: 'NFL',
        yes_payout: 1.90,
        no_payout: 2.00,
        resolves_at: new Date('2026-02-08T23:00:00Z'),
        featured: false
      },
      {
        title: 'Apple will announce new product at Feb event',
        category: 'events',
        ticker: 'AAPL',
        yes_payout: 1.50,
        no_payout: 2.75,
        resolves_at: new Date('2026-02-28T23:59:00Z'),
        featured: false
      },
      {
        title: 'Netflix earnings beat expectations',
        category: 'events',
        ticker: 'NFLX',
        yes_payout: 1.80,
        no_payout: 2.10,
        resolves_at: new Date('2026-01-21T21:00:00Z'),
        featured: false
      },
      {
        title: 'Tesla Q4 deliveries exceed 500K',
        category: 'events',
        ticker: 'TSLA',
        yes_payout: 2.20,
        no_payout: 1.75,
        resolves_at: new Date('2026-01-25T16:00:00Z'),
        featured: false
      }
    ];
    
    let inserted = 0;
    
    for (const pred of predictions) {
      const opensAt = new Date(); // Opens now
      const closesAt = new Date(pred.resolves_at.getTime() - 60000); // Closes 1 min before resolution
      
      const result = await client.query(`
        INSERT INTO predictions (title, category, ticker, yes_payout_multiplier, no_payout_multiplier, opens_at, closes_at, resolves_at, featured, status, min_bet, max_bet)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 10, 10000)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [pred.title, pred.category, pred.ticker, pred.yes_payout, pred.no_payout, opensAt, closesAt, pred.resolves_at, pred.featured]);
      
      if (result.rows.length > 0) {
        console.log(`✅ ${pred.category.toUpperCase()}: ${pred.title}`);
        inserted++;
      } else {
        console.log(`⏭️  Skipped (exists): ${pred.title}`);
      }
    }
    
    console.log(`\n🎉 Done! Inserted ${inserted} new predictions.`);
    
    // Show counts per category
    const counts = await client.query(`
      SELECT category, COUNT(*) as count 
      FROM predictions 
      WHERE status = 'active'
      GROUP BY category
      ORDER BY category
    `);
    
    console.log('\n📊 Predictions by category:');
    counts.rows.forEach(row => {
      console.log(`   ${row.category}: ${row.count}`);
    });
    
  } catch (err) {
    console.error('❌ Error seeding predictions:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

// Helper functions for dates
function getNextMarketClose() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setHours(16, 0, 0, 0); // 4pm ET
  if (now > et) {
    et.setDate(et.getDate() + 1);
  }
  // Skip weekends
  while (et.getDay() === 0 || et.getDay() === 6) {
    et.setDate(et.getDate() + 1);
  }
  return et;
}

function getNextFriday() {
  const now = new Date();
  const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + daysUntilFriday);
  friday.setHours(16, 0, 0, 0);
  return friday;
}

function getEndOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
}

seedPredictions();
