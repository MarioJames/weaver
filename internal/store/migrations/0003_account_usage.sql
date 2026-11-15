-- Admin key and spend/balance bookkeeping for API channels that support usage
-- queries (OpenAI and Anthropic official only). The admin key goes in and
-- never comes back out; nullable columns mean "not set".
ALTER TABLE accounts ADD COLUMN admin_key TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN balance_usd REAL;
ALTER TABLE accounts ADD COLUMN balance_at INTEGER;
ALTER TABLE accounts ADD COLUMN balance_baseline_usd REAL;
ALTER TABLE accounts ADD COLUMN alert_below_usd REAL;
ALTER TABLE accounts ADD COLUMN usage_interval_s INTEGER NOT NULL DEFAULT 300;
ALTER TABLE accounts ADD COLUMN usage_spent_month_usd REAL;
ALTER TABLE accounts ADD COLUMN usage_since_balance_usd REAL;
ALTER TABLE accounts ADD COLUMN usage_checked_at INTEGER;
ALTER TABLE accounts ADD COLUMN usage_error TEXT NOT NULL DEFAULT '';
