CREATE TABLE missions(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace TEXT NOT NULL,
  notify_session TEXT NOT NULL DEFAULT '',
  notify_pane TEXT NOT NULL DEFAULT '',
  wake_cursor INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE packages(
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  workspace TEXT NOT NULL,
  worker TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  waiting TEXT NOT NULL DEFAULT '',
  next_note TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(mission_id, key)
);
CREATE INDEX packages_state ON packages(state);

CREATE TABLE package_deps(
  package_id TEXT NOT NULL REFERENCES packages(id),
  depends_on TEXT NOT NULL REFERENCES packages(id),
  PRIMARY KEY(package_id, depends_on)
);
CREATE INDEX package_deps_upstream ON package_deps(depends_on);

CREATE TABLE attempts(
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  n INTEGER NOT NULL,
  state TEXT NOT NULL,
  worker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  mode TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  run_dir TEXT NOT NULL DEFAULT '',
  vendor_session TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  handed_at INTEGER,
  started_at INTEGER,
  first_output_at INTEGER,
  last_event_at INTEGER,
  finished_at INTEGER,
  stalled_at INTEGER,
  exit_code INTEGER,
  failure_kind TEXT NOT NULL DEFAULT '',
  failure_message TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  UNIQUE(package_id, n)
);
CREATE INDEX attempts_state ON attempts(state);

CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  package_id TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  wake INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX events_mission ON events(mission_id, seq);

CREATE TABLE timers(
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  due_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  cancelled_at INTEGER
);

CREATE TABLE commands(
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  response TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE accounts(
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  auth_dir TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  ready INTEGER NOT NULL DEFAULT 0,
  ready_reason TEXT NOT NULL DEFAULT '',
  checked_at INTEGER,
  paused_until INTEGER,
  pause_reason TEXT NOT NULL DEFAULT '',
  limit_level INTEGER NOT NULL DEFAULT 0,
  limit_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE workers(
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 5,
  max_parallel INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE worker_accounts(
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(worker_id, account_id)
);

CREATE TABLE residents(
  account_id TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  port INTEGER NOT NULL,
  secret TEXT NOT NULL,
  dir TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE TABLE settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
