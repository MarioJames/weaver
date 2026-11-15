CREATE TABLE owner_sessions (
 engine TEXT NOT NULL, session TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
 offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '', synced_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(engine, session)
);
CREATE TABLE session_items (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, engine TEXT NOT NULL, session TEXT NOT NULL,
 at INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
 tool TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, ref TEXT NOT NULL DEFAULT ''
);
CREATE INDEX session_items_session_seq ON session_items(engine, session, seq);
INSERT OR IGNORE INTO owner_sessions(engine,session) SELECT owner_engine,owner_session FROM missions WHERE owner_engine IN ('claude','codex') AND owner_session<>'';
