-- Migration 006: explicit monitor targets and notification bookkeeping.
--
-- Historical UIDs should stay queryable without becoming permanent offline
-- alerts. Only rows in monitor_targets with is_enabled=1 are treated as
-- production runtime targets by health checks and external monitors.

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

CREATE INDEX IF NOT EXISTS idx_monitor_targets_enabled ON monitor_targets(is_enabled, updated_at);

ALTER TABLE alert_events ADD COLUMN notified_at INTEGER;
ALTER TABLE alert_events ADD COLUMN notification_channel TEXT;
ALTER TABLE alert_events ADD COLUMN notification_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alert_events ADD COLUMN last_notification_error TEXT;
