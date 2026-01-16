-- Predictions Market Database Schema
-- Run this migration on your Railway PostgreSQL instance

-- =====================================================
-- USER TOKENS TABLE
-- Tracks token balances for each user
-- =====================================================
CREATE TABLE IF NOT EXISTS user_tokens (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) UNIQUE NOT NULL,
    balance INTEGER DEFAULT 0,
    total_purchased INTEGER DEFAULT 0,
    total_won INTEGER DEFAULT 0,
    total_lost INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_tokens_email ON user_tokens(user_email);

-- =====================================================
-- TOKEN PURCHASES TABLE
-- Records all token purchase transactions
-- =====================================================
CREATE TABLE IF NOT EXISTS token_purchases (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    package_name VARCHAR(50) NOT NULL,
    tokens_amount INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    stripe_payment_intent_id VARCHAR(255),
    stripe_checkout_session_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (user_email) REFERENCES user_tokens(user_email) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_token_purchases_user ON token_purchases(user_email);
CREATE INDEX IF NOT EXISTS idx_token_purchases_stripe ON token_purchases(stripe_checkout_session_id);

-- =====================================================
-- PREDICTIONS TABLE
-- Active and historical prediction markets
-- =====================================================
CREATE TABLE IF NOT EXISTS predictions (
    id SERIAL PRIMARY KEY,
    category VARCHAR(50) NOT NULL,
    subcategory VARCHAR(50),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    ticker VARCHAR(20),
    parameters JSONB DEFAULT '{}',
    yes_payout_multiplier DECIMAL(4,2) DEFAULT 2.00,
    no_payout_multiplier DECIMAL(4,2) DEFAULT 2.00,
    min_bet INTEGER DEFAULT 10,
    max_bet INTEGER DEFAULT 10000,
    opens_at TIMESTAMP NOT NULL,
    closes_at TIMESTAMP NOT NULL,
    resolves_at TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'upcoming',
    outcome VARCHAR(10),
    resolution_source TEXT,
    resolved_at TIMESTAMP,
    resolved_by VARCHAR(255),
    total_yes_tokens INTEGER DEFAULT 0,
    total_no_tokens INTEGER DEFAULT 0,
    total_bettors INTEGER DEFAULT 0,
    featured BOOLEAN DEFAULT FALSE,
    image_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
CREATE INDEX IF NOT EXISTS idx_predictions_category ON predictions(category);
CREATE INDEX IF NOT EXISTS idx_predictions_ticker ON predictions(ticker);
CREATE INDEX IF NOT EXISTS idx_predictions_closes_at ON predictions(closes_at);
CREATE INDEX IF NOT EXISTS idx_predictions_featured ON predictions(featured) WHERE featured = TRUE;

-- =====================================================
-- USER BETS TABLE
-- All bets placed by users
-- =====================================================
CREATE TABLE IF NOT EXISTS user_bets (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    prediction_id INTEGER NOT NULL,
    position VARCHAR(3) NOT NULL,
    tokens_wagered INTEGER NOT NULL,
    potential_payout INTEGER NOT NULL,
    payout_multiplier DECIMAL(4,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    tokens_won INTEGER DEFAULT 0,
    payout_processed BOOLEAN DEFAULT FALSE,
    payout_processed_at TIMESTAMP,
    placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_email) REFERENCES user_tokens(user_email) ON DELETE CASCADE,
    FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_bets_user ON user_bets(user_email);
CREATE INDEX IF NOT EXISTS idx_user_bets_prediction ON user_bets(prediction_id);
CREATE INDEX IF NOT EXISTS idx_user_bets_status ON user_bets(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_bets_unique ON user_bets(user_email, prediction_id);

-- =====================================================
-- PAYOUT REQUESTS TABLE
-- Track withdrawal requests (Zelle/PayPal)
-- =====================================================
CREATE TABLE IF NOT EXISTS payout_requests (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    tokens_amount INTEGER NOT NULL,
    usd_amount DECIMAL(10,2) NOT NULL,
    payout_method VARCHAR(20) NOT NULL,
    payout_destination VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP,
    rejection_reason TEXT,
    transaction_reference VARCHAR(255),
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_email) REFERENCES user_tokens(user_email) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_user ON payout_requests(user_email);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status);

-- =====================================================
-- PREDICTION TEMPLATES TABLE
-- Reusable templates for recurring predictions
-- =====================================================
CREATE TABLE IF NOT EXISTS prediction_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    subcategory VARCHAR(50),
    title_template VARCHAR(255) NOT NULL,
    description_template TEXT,
    parameters_template JSONB DEFAULT '{}',
    default_yes_multiplier DECIMAL(4,2) DEFAULT 2.00,
    default_no_multiplier DECIMAL(4,2) DEFAULT 2.00,
    recurrence VARCHAR(20),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- HELPER FUNCTION: Auto-update updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_user_tokens_updated_at ON user_tokens;
CREATE TRIGGER update_user_tokens_updated_at
    BEFORE UPDATE ON user_tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_predictions_updated_at ON predictions;
CREATE TRIGGER update_predictions_updated_at
    BEFORE UPDATE ON predictions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SEED DATA: Prediction Templates
-- =====================================================
INSERT INTO prediction_templates (name, category, subcategory, title_template, description_template, parameters_template, recurrence) VALUES
('Daily Close Green', 'daily', 'close_green', 'Will {ticker} close green today?', 'Predict whether {ticker} will close higher than its opening price today.', '{"type": "close_green"}', 'daily'),
('Daily Close Red', 'daily', 'close_red', 'Will {ticker} close red today?', 'Predict whether {ticker} will close lower than its opening price today.', '{"type": "close_red"}', 'daily'),
('Weekly Range', 'weekly', 'range', 'Will {ticker} move ±{range_pct}% this week?', 'Predict whether {ticker} will have a weekly range of at least ±{range_pct}%.', '{"type": "weekly_range"}', 'weekly'),
('Weekly Direction', 'weekly', 'direction', 'Will {ticker} finish the week higher?', 'Predict whether {ticker} will close Friday higher than Monday open.', '{"type": "weekly_direction"}', 'weekly'),
('Earnings Beat', 'earnings', 'beat_miss', 'Will {ticker} beat earnings estimates?', '{ticker} reports earnings on {date}. Will they beat analyst EPS estimates?', '{"type": "earnings_beat"}', NULL),
('Fed Rate Decision', 'fed', 'rate_decision', 'Will the Fed {action} rates at the {meeting} meeting?', 'The Federal Reserve meets on {date}. Predict their rate decision.', '{"type": "fed_rate"}', NULL),
('BTC Price Target', 'crypto', 'price_target', 'Will BTC hit ${target} by {date}?', 'Predict whether Bitcoin will reach the target price.', '{"type": "crypto_price"}', NULL)
ON CONFLICT DO NOTHING;

-- =====================================================
-- VIEWS FOR COMMON QUERIES
-- =====================================================
CREATE OR REPLACE VIEW v_active_predictions AS
SELECT 
    p.*,
    COALESCE(SUM(CASE WHEN b.position = 'yes' THEN b.tokens_wagered ELSE 0 END), 0) as yes_volume,
    COALESCE(SUM(CASE WHEN b.position = 'no' THEN b.tokens_wagered ELSE 0 END), 0) as no_volume,
    COUNT(DISTINCT b.user_email) as unique_bettors
FROM predictions p
LEFT JOIN user_bets b ON p.id = b.prediction_id AND b.status = 'active'
WHERE p.status IN ('upcoming', 'open')
GROUP BY p.id;

CREATE OR REPLACE VIEW v_user_bet_history AS
SELECT 
    b.*,
    p.title as prediction_title,
    p.category,
    p.ticker,
    p.outcome as prediction_outcome,
    p.status as prediction_status,
    p.resolves_at
FROM user_bets b
JOIN predictions p ON b.prediction_id = p.id;

CREATE OR REPLACE VIEW v_leaderboard AS
SELECT 
    ut.user_email,
    ut.balance,
    ut.total_won,
    ut.total_lost,
    (ut.total_won - ut.total_lost) as net_profit,
    COUNT(ub.id) as total_bets,
    COUNT(CASE WHEN ub.status = 'won' THEN 1 END) as wins,
    COUNT(CASE WHEN ub.status = 'lost' THEN 1 END) as losses,
    CASE 
        WHEN COUNT(CASE WHEN ub.status IN ('won', 'lost') THEN 1 END) > 0 
        THEN ROUND(COUNT(CASE WHEN ub.status = 'won' THEN 1 END)::DECIMAL / 
             COUNT(CASE WHEN ub.status IN ('won', 'lost') THEN 1 END) * 100, 1)
        ELSE 0 
    END as win_rate
FROM user_tokens ut
LEFT JOIN user_bets ub ON ut.user_email = ub.user_email
GROUP BY ut.user_email, ut.balance, ut.total_won, ut.total_lost
ORDER BY net_profit DESC;
