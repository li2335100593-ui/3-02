import assert from 'node:assert/strict';

const worker = (await import('../worker/src/index.js')).default;

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signPlaybackToken(secret, payload) {
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(Buffer.from(sig))}`;
}

function makeDb() {
  const rows = [];
  const eventIds = new Set();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT OR IGNORE INTO exposure_events/.test(sql)) {
                const eventId = args[0];
                if (eventId && eventIds.has(eventId)) {
                  return { meta: { changes: 0, last_row_id: rows.length } };
                }
                if (eventId) eventIds.add(eventId);
                rows.push({ event_id: eventId, trusted: args[16], url: args[5], uid: args[4] });
                return { meta: { changes: 1, last_row_id: rows.length } };
              }
              return { meta: { changes: 1 } };
            },
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

async function postExposure(env, body) {
  const req = new Request('https://worker.test/api/exposure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, json: await res.json() };
}

const secret = 'test-secret-for-signed-events';
const db = makeDb();
const env = {
  AUTH_SECRET: secret,
  REQUIRE_EXPOSURE_TOKEN: '1',
  DB: db,
};

const basePayload = {
  event_type: 'heartbeat',
  event_id: 'ev_test_1',
  sid: 'sid_test',
  uid: 'OP_001',
  url: 'https://livingroom-design.ddmmoney.com/article',
  page_index: 0,
  client_ts: Date.now(),
};

{
  const res = await postExposure(env, basePayload);
  assert.equal(res.status, 401);
  assert.match(res.json.error, /token required/);
}

const token = await signPlaybackToken(secret, {
  typ: 'carousel_playback',
  uid: 'OP_001',
  urls: ['https://livingroom-design.ddmmoney.com/'],
  exp: Math.floor(Date.now() / 1000) + 3600,
});

{
  const res = await postExposure(env, { ...basePayload, task_token: token });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.trusted, true);
  assert.equal(db.rows.length, 1);
}

{
  const res = await postExposure(env, { ...basePayload, task_token: token });
  assert.equal(res.status, 200);
  assert.equal(res.json.duplicate, true);
  assert.equal(db.rows.length, 1);
}

{
  const res = await postExposure(env, {
    ...basePayload,
    event_id: 'ev_test_2',
    url: 'https://evil.example.com/',
    task_token: token,
  });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /url mismatch/);
}

console.log(JSON.stringify({ ok: true, signed_events: db.rows.length }));
