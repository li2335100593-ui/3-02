-- Migration 008: signed playback events + idempotency.
-- `event_id` lets the Worker ignore retried sendBeacon/fetch payloads instead
-- of double-counting work time. `trusted` marks events that arrived with a
-- valid playback task token.

ALTER TABLE exposure_events ADD COLUMN event_id TEXT;
ALTER TABLE exposure_events ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_exposure_event_id_unique
  ON exposure_events(event_id)
  WHERE event_id IS NOT NULL;
