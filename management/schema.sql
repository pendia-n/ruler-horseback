-- Rulerhorseback Management: user accounts + credit system + AI validation log
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  credits INTEGER DEFAULT 0,
  stripe_account_id TEXT,
  totp_secret TEXT DEFAULT '',
  totp_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount REAL NOT NULL,
  stripe_session_id TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Track done/lost/due counts for batch credit calculation
CREATE TABLE IF NOT EXISTS user_stats (
  user_id TEXT PRIMARY KEY,
  total_done INTEGER DEFAULT 0,
  total_lost INTEGER DEFAULT 0,
  total_due INTEGER DEFAULT 0,
  net_credit_delta INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Rate limit log for AI validation (10 min per user)
CREATE TABLE IF NOT EXISTS ai_validation_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_val_user_time ON ai_validation_log(user_id, created_at);
