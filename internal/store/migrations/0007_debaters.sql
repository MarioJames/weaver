-- Seed the two fixed dialogue seats from the best-rated enabled codex and
-- claude candidates. Seats stay unrated: they never join automatic routing.
-- Existing seats and their bindings are left untouched.

INSERT OR IGNORE INTO workers(id, engine, model, effort, enabled, position)
SELECT 'debater_a', engine, model, effort, 1, position
FROM workers WHERE id=(SELECT id FROM workers WHERE engine='codex' AND enabled=1 AND id NOT IN ('debater_a','debater_b') ORDER BY intelligence DESC, position, id LIMIT 1);

-- changes() refers to the seat insertion, so existing bindings are untouched.
INSERT OR IGNORE INTO worker_accounts(worker_id, account_id, position)
SELECT 'debater_a', account_id, position FROM worker_accounts
WHERE worker_id=(SELECT id FROM workers WHERE engine='codex' AND enabled=1 AND id NOT IN ('debater_a','debater_b') ORDER BY intelligence DESC, position, id LIMIT 1) AND changes()>0;

INSERT OR IGNORE INTO workers(id, engine, model, effort, enabled, position)
SELECT 'debater_b', engine, model, effort, 1, position
FROM workers WHERE id=(SELECT id FROM workers WHERE engine='claude' AND enabled=1 AND id NOT IN ('debater_a','debater_b') ORDER BY intelligence DESC, position, id LIMIT 1);

INSERT OR IGNORE INTO worker_accounts(worker_id, account_id, position)
SELECT 'debater_b', account_id, position FROM worker_accounts
WHERE worker_id=(SELECT id FROM workers WHERE engine='claude' AND enabled=1 AND id NOT IN ('debater_a','debater_b') ORDER BY intelligence DESC, position, id LIMIT 1) AND changes()>0;
