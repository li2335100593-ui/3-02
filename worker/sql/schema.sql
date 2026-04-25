-- Canonical schema. Reflects production state after migration_002.
-- Used by `wrangler d1 execute --file=schema.sql` for fresh databases.

CREATE TABLE IF NOT EXISTS exposure_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  sid TEXT,
  vid TEXT,
  uid TEXT,
  url TEXT NOT NULL,
  page_index INTEGER,
  device_type TEXT,
  screen_w INTEGER,
  screen_h INTEGER,
  tz_offset INTEGER,
  ip TEXT,
  ua TEXT,
  client_ts INTEGER,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS configured_urls (
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'scheduler',
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exposure_received_at ON exposure_events(received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_received_at ON exposure_events(url, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_ip_received_at ON exposure_events(url, ip, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_vid_received_at ON exposure_events(url, vid, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_uid_received_at ON exposure_events(url, uid, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_uid_received_at ON exposure_events(uid, received_at);
CREATE INDEX IF NOT EXISTS idx_configured_urls_active ON configured_urls(is_active, updated_at);
