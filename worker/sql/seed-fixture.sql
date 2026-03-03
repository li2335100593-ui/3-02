DELETE FROM exposure_events;

INSERT INTO exposure_events (
  id, event_type, sid, vid, url, page_index, ip, user_agent, device_type, client_ts, dwell_ms, received_at
) VALUES
  (
    'evt_1', 'page_enter', 'sid_a', 'vid_a', 'https://a.example.com', 0,
    '1.1.1.1', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'mobile',
    1772400000000, 0, 1772400000000
  ),
  (
    'evt_2', 'page_enter', 'sid_a', 'vid_a', 'https://a.example.com', 0,
    '1.1.1.1', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'mobile',
    1772400600000, 0, 1772400600000
  ),
  (
    'evt_3', 'page_enter', 'sid_b', 'vid_b', 'https://a.example.com', 0,
    '2.2.2.2', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36', 'desktop',
    1772401200000, 0, 1772401200000
  ),
  (
    'evt_4', 'page_enter', 'sid_c', 'vid_c', 'https://b.example.com', 1,
    '3.3.3.3', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36', 'mobile',
    1772486400000, 0, 1772486400000
  );
