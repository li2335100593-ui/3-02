-- Migration 003: Site management table.
--
-- Lets clients add/remove tracked websites from the SaaS panel without
-- editing scheduler.html / carousel.js. scheduler reads this list at
-- bootstrap.
--
-- The pre-existing `operators` table already covers operator management;
-- we just expose CRUD endpoints over it from the Worker.

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  note TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sites_active ON sites(is_active, created_at);
