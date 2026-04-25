-- Migration 002: Add operator-tracking columns to exposure_events
-- Idempotent: re-runs are safe (D1 raises error on duplicate column, wrap in handler when applying)
--
-- Adds:
--   uid       — operator identifier (from scheduler ?u=xxx)
--   screen_w  — viewport width at page_enter (px)
--   screen_h  — viewport height at page_enter (px)
--   tz_offset — minutes offset from UTC (Date.getTimezoneOffset)
--
-- Rationale: operator-level audit (per-worker working hours) was impossible
-- without uid. Screen + tz fields strengthen device fingerprint for payroll
-- dispute resolution.

ALTER TABLE exposure_events ADD COLUMN uid TEXT;
ALTER TABLE exposure_events ADD COLUMN screen_w INTEGER;
ALTER TABLE exposure_events ADD COLUMN screen_h INTEGER;
ALTER TABLE exposure_events ADD COLUMN tz_offset INTEGER;

CREATE INDEX IF NOT EXISTS idx_exposure_uid_received_at ON exposure_events(uid, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_uid_received_at ON exposure_events(url, uid, received_at);
