DELETE FROM exposure_events;

INSERT INTO exposure_events (
  event_type, sid, vid, uid, url, page_index, ip, ua, device_type,
  screen_w, screen_h, tz_offset, client_ts, received_at
) VALUES
  (
    'page_enter', 'sid_a', 'vid_a', 'fixture_operator',
    'https://a.example.com', 0, '1.1.1.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'mobile', 390, 844, -480, 1772400000000, 1772400000000
  ),
  (
    'heartbeat', 'sid_a', 'vid_a', 'fixture_operator',
    'https://a.example.com', 0, '1.1.1.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'mobile', 390, 844, -480, 1772400030000, 1772400030000
  ),
  (
    'page_enter', 'sid_b', 'vid_b', 'fixture_operator_2',
    'https://b.example.com', 1, '2.2.2.2',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'desktop', 1440, 900, -480, 1772486400000, 1772486400000
  );
