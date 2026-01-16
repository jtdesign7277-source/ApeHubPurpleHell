// =====================================================
// AUTO-RESOLVE PREDICTIONS
// Run this after market close (4:30pm ET) to resolve daily predictions
// Uses free Yahoo Finance API to check closing prices
// =====================================================

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// =====================================================
// YAHOO FINANCE API (Free, no key needed)
// =====================================================

async function getQuote(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Yahoo Finance API error: ${response.status}`);
    }
    
    const data = await response.json();
    const result = data.chart.result[0];
    const meta = result.meta;
    const quote = result.indicators.quote[0];
    
    const open = quote.open[quote.open.length - 1];
    const close = quote.close[quote.close.length - 1] || meta.regularMarketPrice;
    const previousClose = meta.chartPreviousClose || meta.previousClose;
    
    return {
      ticker,
      open: open,
      close: close,
      previousClose: previousClose,
      change: close - open,
      changePercent: ((close - open) / open * 100).toFixed(2),
      isGreen: close > open,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`Error fetching ${ticker}:`, error.message);
    return null;
  }
}

// =====================================================
// RESOLUTION LOGIC
// =====================================================

async function resolveDailyCloseGreen(prediction) {
  const quote = await getQuote(prediction.ticker);
  
  if (!quote) {
    console.log(`⚠️  Could not fetch data for ${prediction.ticker} - skipping`);
    return null;
  }
  
  const outcome = quote.isGreen ? 'yes' : 'no';
  const source = `Yahoo Finance: Open $${quote.open?.toFixed(2)}, Close $${quote.close?.toFixed(2)} (${quote.changePercent}%)`;
  
  console.log(`📊 ${prediction.ticker}: ${quote.isGreen ? '🟢 GREEN' : '🔴 RED'} (${quote.changePercent}%)`);
  
  return { outcome, source, quote };
}

async function resolveWeeklyRange(prediction) {
  const quote = await getQuote(prediction.ticker);
  
  if (!quote) {
    console.log(`⚠️  Could not fetch data for ${prediction.ticker} - skipping`);
    return null;
  }
  
  const params = prediction.parameters;
  const targetRange = params.range_pct || 5;
  
  const weekUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${prediction.ticker}?interval=1d&range=5d`;
  
  try {
    const response = await fetch(weekUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const data = await response.json();
    const result = data.chart.result[0];
    const quotes = result.indicators.quote[0];
    
    const mondayOpen = quotes.open[0];
    const fridayClose = quotes.close[quotes.close.length - 1];
    
    const weeklyChange = ((fridayClose - mondayOpen) / mondayOpen * 100);
    const movedEnough = Math.abs(weeklyChange) >= targetRange;
    
    const outcome = movedEnough ? 'yes' : 'no';
    const source = `Yahoo Finance: Monday Open $${mondayOpen?.toFixed(2)}, Friday Close $${fridayClose?.toFixed(2)} (${weeklyChange.toFixed(2)}% vs ±${targetRange}% target)`;
    
    console.log(`📊 ${prediction.ticker} Weekly: ${movedEnough ? '✅ HIT' : '❌ MISSED'} target (${weeklyChange.toFixed(2)}%)`);
    
    return { outcome, source };
    
  } catch (error) {
    console.error(`Error fetching weekly data for ${prediction.ticker}:`, error.message);
    return null;
  }
}

// =====================================================
// PROCESS BETS (Pay winners, update losers)
// =====================================================

async function processBetsForPrediction(predictionId, outcome) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const betsResult = await client.query(
      'SELECT * FROM user_bets WHERE prediction_id = $1 AND status = \'active\'',
      [predictionId]
    );
    
    let winners = 0;
    let losers = 0;
    let totalPaidOut = 0;
    
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
        winners++;
        totalPaidOut += tokensWon;
      } else {
        await client.query(
          `UPDATE user_tokens 
           SET total_lost = total_lost + $1
           WHERE user_email = $2`,
          [bet.tokens_wagered, bet.user_email]
        );
        losers++;
      }
    }
    
    await client.query('COMMIT');
    
    return { winners, losers, totalPaidOut, totalBets: betsResult.rows.length };
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// =====================================================
// MAIN RESOLUTION FUNCTION
// =====================================================

async function resolveReadyPredictions() {
  console.log('═'.repeat(50));
  console.log('⚖️  AUTO-RESOLUTION ENGINE');
  console.log(`   Running at: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
  console.log('═'.repeat(50));
  
  try {
    const readyResult = await pool.query(
      `SELECT * FROM predictions 
       WHERE status = 'closed' 
       AND outcome IS NULL
       AND resolves_at <= NOW()
       ORDER BY resolves_at ASC`
    );
    
    if (readyResult.rows.length === 0) {
      console.log('\n✅ No predictions ready to resolve\n');
      return { resolved: 0 };
    }
    
    console.log(`\n📋 Found ${readyResult.rows.length} predictions to resolve:\n`);
    
    let resolved = 0;
    let failed = 0;
    
    for (const prediction of readyResult.rows) {
      console.log(`\n🎯 Resolving: ${prediction.title}`);
      console.log(`   Category: ${prediction.category}/${prediction.subcategory}`);
      
      let resolution = null;
      
      if (prediction.subcategory === 'close_green') {
        resolution = await resolveDailyCloseGreen(prediction);
      } else if (prediction.subcategory === 'range') {
        resolution = await resolveWeeklyRange(prediction);
      } else {
        console.log(`   ⚠️  Unknown subcategory: ${prediction.subcategory} - requires manual resolution`);
        continue;
      }
      
      if (!resolution) {
        failed++;
        continue;
      }
      
      await pool.query(
        `UPDATE predictions 
         SET status = 'resolved',
             outcome = $1,
             resolution_source = $2,
             resolved_at = NOW(),
             resolved_by = 'auto-resolver'
         WHERE id = $3`,
        [resolution.outcome, resolution.source, prediction.id]
      );
      
      const betResults = await processBetsForPrediction(prediction.id, resolution.outcome);
      
      console.log(`   ✅ Resolved as: ${resolution.outcome.toUpperCase()}`);
      console.log(`   💰 Bets processed: ${betResults.totalBets} (${betResults.winners} winners, ${betResults.losers} losers)`);
      console.log(`   🪙 Total paid out: ${betResults.totalPaidOut.toLocaleString()} tokens`);
      
      resolved++;
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log('\n' + '═'.repeat(50));
    console.log(`✅ RESOLUTION COMPLETE: ${resolved} resolved, ${failed} failed`);
    console.log('═'.repeat(50) + '\n');
    
    return { resolved, failed };
    
  } catch (error) {
    console.error('❌ Resolution failed:', error);
    return { success: false, error: error.message };
  }
}

// =====================================================
// MANUAL RESOLUTION HELPER
// =====================================================

async function manualResolve(predictionId, outcome, adminEmail, source = 'Manual resolution') {
  if (!['yes', 'no'].includes(outcome)) {
    throw new Error('Outcome must be "yes" or "no"');
  }
  
  await pool.query(
    `UPDATE predictions 
     SET status = 'resolved',
         outcome = $1,
         resolution_source = $2,
         resolved_at = NOW(),
         resolved_by = $3
     WHERE id = $4`,
    [outcome, source, adminEmail, predictionId]
  );
  
  const betResults = await processBetsForPrediction(predictionId, outcome);
  
  return {
    success: true,
    outcome,
    ...betResults
  };
}

// =====================================================
// RUN IF EXECUTED DIRECTLY
// =====================================================

if (require.main === module) {
  resolveReadyPredictions()
    .then(() => {
      console.log('👋 Done! Exiting...\n');
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

module.exports = {
  resolveReadyPredictions,
  manualResolve,
  getQuote,
  resolveDailyCloseGreen,
  resolveWeeklyRange
};
