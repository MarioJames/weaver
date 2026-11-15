ALTER TABLE missions ADD COLUMN owner_engine TEXT NOT NULL DEFAULT '';
ALTER TABLE missions ADD COLUMN owner_session TEXT NOT NULL DEFAULT '';
ALTER TABLE missions ADD COLUMN archived_at INTEGER;
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY,
 mission_id TEXT NOT NULL REFERENCES missions(id),
 package_key TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL CHECK(kind IN ('design','report','evidence','doc')),
 title TEXT NOT NULL,
 group_key TEXT NOT NULL,
 path TEXT NOT NULL DEFAULT '',
 url TEXT NOT NULL DEFAULT '',
 sha256 TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL DEFAULT 0,
 summary TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL
);
CREATE INDEX artifacts_mission ON artifacts(mission_id);
CREATE UNIQUE INDEX artifacts_url ON artifacts(mission_id,url) WHERE url <> '';
