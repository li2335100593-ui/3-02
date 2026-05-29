-- Migration 005: runtime health and alert state.
--
-- `exposure_events` remains the append-only source of truth for reports.
-- These tables are derived operational state: they make it cheap to show
-- whether a player is currently healthy and why it is not.

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

CREATE INDEX IF NOT EXISTS idx_player_status_last_seen ON player_status(last_seen);

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
  acknowledged_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_events_status_last_seen ON alert_events(status, last_seen);
CREATE INDEX IF NOT EXISTS idx_alert_events_uid_status ON alert_events(uid, status);
