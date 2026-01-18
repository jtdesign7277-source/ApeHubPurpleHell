-- Kalshi Bets Table
-- Tracks bets placed on Kalshi markets using our token system

CREATE TABLE IF NOT EXISTS kalshi_bets (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    kalshi_ticker VARCHAR(100) NOT NULL,
    event_ticker VARCHAR(100),
    market_title TEXT,
    position VARCHAR(3) NOT NULL CHECK (position IN ('yes', 'no')),
    tokens_wagered INTEGER NOT NULL,
    potential_payout INTEGER NOT NULL,
    payout_multiplier DECIMAL(6,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'won', 'lost', 'cancelled')),
    kalshi_status VARCHAR(50) DEFAULT 'open',
    tokens_won INTEGER DEFAULT 0,
    placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY (user_email) REFERENCES user_tokens(user_email) ON DELETE CASCADE
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_kalshi_bets_user ON kalshi_bets(user_email);
CREATE INDEX IF NOT EXISTS idx_kalshi_bets_ticker ON kalshi_bets(kalshi_ticker);
CREATE INDEX IF NOT EXISTS idx_kalshi_bets_status ON kalshi_bets(status);
CREATE INDEX IF NOT EXISTS idx_kalshi_bets_event ON kalshi_bets(event_ticker);

-- Unique constraint: one bet per user per market
CREATE UNIQUE INDEX IF NOT EXISTS idx_kalshi_bets_unique ON kalshi_bets(user_email, kalshi_ticker);
