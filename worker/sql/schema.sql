CREATE TABLE IF NOT EXISTS exposure_events (
  id TEXT PRIMARY KEY,
  event_type TEXT,
  sid TEXT,
  vid TEXT,
  url TEXT NOT NULL,
  page_index INTEGER,
  ip TEXT,
  user_agent TEXT,
  device_type TEXT,
  client_ts INTEGER,
  dwell_ms INTEGER,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exposure_received_at ON exposure_events(received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_received_at ON exposure_events(url, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_ip_received_at ON exposure_events(url, ip, received_at);
CREATE INDEX IF NOT EXISTS idx_exposure_url_vid_received_at ON exposure_events(url, vid, received_at);
