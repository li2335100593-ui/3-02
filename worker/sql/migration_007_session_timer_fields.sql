-- Migration 007: persist client session timer readings.
--
-- The UI timer and report use the same session clock. These fields keep the
-- exact client-side stopwatch values on every event so audits can compare the
-- visible timer with the backend record without deriving time from heartbeat
-- counts.

ALTER TABLE exposure_events ADD COLUMN session_start_ms INTEGER;
ALTER TABLE exposure_events ADD COLUMN session_elapsed_ms INTEGER;

ALTER TABLE player_status ADD COLUMN session_start_ms INTEGER;
ALTER TABLE player_status ADD COLUMN last_session_elapsed_ms INTEGER;
