-- advisory: the package produces a document and must leave files alone.
-- auto_accept: its result is accepted as it arrives and releases its dependents.
ALTER TABLE packages ADD COLUMN advisory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0;
