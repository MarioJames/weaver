-- Usage comes from what each run reports instead of the vendors' spend APIs,
-- which need an organization admin key that individual accounts cannot get.
-- Runs keep their cache tokens and the engine's own price. Accounts keep the
-- hand-entered balance and alert line; prices are per account and model,
-- since one account serves models of different prices. The admin key and the
-- stored query results go.
ALTER TABLE attempts ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN cost_usd REAL;
CREATE INDEX IF NOT EXISTS attempts_account_finished ON attempts(account_id, finished_at);
CREATE TABLE IF NOT EXISTS model_prices(
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_usd REAL,
  output_usd REAL,
  cache_read_usd REAL,
  cache_write_usd REAL,
  PRIMARY KEY(account_id, model)
);
ALTER TABLE accounts DROP COLUMN admin_key;
ALTER TABLE accounts DROP COLUMN balance_baseline_usd;
ALTER TABLE accounts DROP COLUMN usage_interval_s;
ALTER TABLE accounts DROP COLUMN usage_spent_month_usd;
ALTER TABLE accounts DROP COLUMN usage_since_balance_usd;
ALTER TABLE accounts DROP COLUMN usage_checked_at;
ALTER TABLE accounts DROP COLUMN usage_error;
