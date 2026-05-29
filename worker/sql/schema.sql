-- Canonical schema. Reflects production state after migration_006.
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

CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_code TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  note TEXT,
  target_urls TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  note TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login INTEGER
);

CREATE TABLE IF NOT EXISTS player_status (
  uid TEXT PRIMARY KEY,
  sid TEXT,
  current_url TEXT,
  page_index INTEGER,
  last_event_type TEXT,
  last_seen INTEGER NOT NULL,
  last_heartbeat_at INTEGER,
  last_page_enter_at INTEGER,
  queue_length INTEGER,
  client_version TEXT,
  visibility_state TEXT,
  navigation_slot INTEGER,
  last_flush_ok INTEGER,
  device_type TEXT,
  screen_w INTEGER,
  screen_h INTEGER,
  tz_offset INTEGER,
  ip TEXT,
  ua TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  uid TEXT,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  notified_at INTEGER,
  notification_channel TEXT,
  notification_count INTEGER NOT NULL DEFAULT 0,
  last_notification_error TEXT
);

CREATE TABLE IF NOT EXISTS monitor_targets (
  uid TEXT PRIMARY KEY,
  label TEXT,
  expected_urls_json TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  stale_after_sec INTEGER NOT NULL DEFAULT 300,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exposure_received_at ON exposure_events(received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_received_at ON exposure_events(url, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_ip_received_at ON exposure_events(url, ip, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_vid_received_at ON exposure_events(url, vid, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_uid_received_at ON exposure_events(url, uid, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_uid_received_at ON exposure_events(uid, received_at);
CREATE INDEX IF NOT EXISTS idx_configured_urls_active ON configured_urls(is_active, updated_at);
CREATE INDEX IF NOT EXISTS idx_sites_active ON sites(is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_player_status_last_seen ON player_status(last_seen);
CREATE INDEX IF NOT EXISTS idx_alert_events_status_last_seen ON alert_events(status, last_seen);
CREATE INDEX IF NOT EXISTS idx_alert_events_uid_status ON alert_events(uid, status);
CREATE INDEX IF NOT EXISTS idx_monitor_targets_enabled ON monitor_targets(is_enabled, updated_at);
