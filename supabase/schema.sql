-- ================================================================
-- Solana Trading Bot — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================

-- Tokens discovered
CREATE TABLE IF NOT EXISTS tokens (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  mint         TEXT UNIQUE NOT NULL,
  symbol       TEXT,
  name         TEXT,
  decimals     INTEGER DEFAULT 9,
  pump_fun     BOOLEAN DEFAULT FALSE,
  liquidity_usd DECIMAL,
  market_cap_usd DECIMAL,
  dev_wallet   TEXT,
  rug_score    INTEGER,
  metadata     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Trade signals
CREATE TABLE IF NOT EXISTS signals (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  strategy        TEXT NOT NULL,
  token_mint      TEXT REFERENCES tokens(mint),
  signal_type     TEXT NOT NULL,
  confidence      DECIMAL,
  source          TEXT,
  rug_score       INTEGER,
  gemini_analysis JSONB,
  acted_on        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Paper trades
CREATE TABLE IF NOT EXISTS paper_trades (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_id    INTEGER NOT NULL,
  strategy     TEXT NOT NULL,
  token_mint   TEXT NOT NULL,
  token_symbol TEXT,
  action       TEXT NOT NULL,
  amount_sol   DECIMAL NOT NULL,
  token_amount DECIMAL,
  price_sol    DECIMAL,
  price_usd    DECIMAL,
  slippage_pct DECIMAL,
  signal_id    UUID REFERENCES signals(id),
  pnl_sol      DECIMAL,
  pnl_pct      DECIMAL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Open positions per wallet
CREATE TABLE IF NOT EXISTS portfolio (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_id     INTEGER NOT NULL,
  token_mint    TEXT NOT NULL,
  token_symbol  TEXT,
  amount        DECIMAL NOT NULL DEFAULT 0,
  avg_entry_sol DECIMAL,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(wallet_id, token_mint)
);

-- KOL handles to track
CREATE TABLE IF NOT EXISTS kol_watchlist (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  handle     TEXT UNIQUE NOT NULL,
  platform   TEXT DEFAULT 'twitter',
  active     BOOLEAN DEFAULT TRUE,
  added_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Wallets to copy trade
CREATE TABLE IF NOT EXISTS copy_wallets (
  id       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address  TEXT UNIQUE NOT NULL,
  label    TEXT,
  active   BOOLEAN DEFAULT TRUE,
  win_rate DECIMAL,
  avg_pnl  DECIMAL,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trades_strategy    ON paper_trades(strategy);
CREATE INDEX IF NOT EXISTS idx_trades_wallet      ON paper_trades(wallet_id);
CREATE INDEX IF NOT EXISTS idx_trades_created     ON paper_trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_wallet   ON portfolio(wallet_id);
CREATE INDEX IF NOT EXISTS idx_signals_strategy   ON signals(strategy);

-- ================================================================
-- Seed: Add your KOL handles here
-- INSERT INTO kol_watchlist (handle) VALUES ('MustStopMurad'), ('ansem'), ('cobie');
--
-- Seed: Add copy trade wallets here after research
-- INSERT INTO copy_wallets (address, label) VALUES ('WALLET_ADDRESS', 'Alpha Trader 1');
-- ================================================================
