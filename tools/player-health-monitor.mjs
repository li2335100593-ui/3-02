#!/usr/bin/env node

const base = process.env.ANALYTICS_BASE || 'https://exposure-analytics.li2335100593.workers.dev';
const username = process.env.REPORT_USER;
const password = process.env.REPORT_PASS;
const intervalSec = Number(process.env.MONITOR_INTERVAL_SEC || 60);
const once = process.argv.includes('--once');

if (!username || !password) {
  console.error('REPORT_USER and REPORT_PASS are required');
  process.exit(2);
}

async function login() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const json = await res.json();
  if (!json.token) throw new Error('login response missing token');
  return json.token;
}

async function getHealth(token) {
  const res = await fetch(`${base}/api/player-health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`player-health failed: ${res.status}`);
  return res.json();
}

function summarize(health) {
  const players = health.players || [];
  const alerts = health.alerts || [];
  return {
    ts: new Date().toISOString(),
    totals: health.totals || {},
    players: players.map((p) => ({
      uid: p.uid,
      health: p.health,
      age_seconds: p.age_seconds,
      current_url: p.current_url,
      queue_length: p.queue_length,
      client_version: p.client_version,
      today_urls: p.today?.visited_urls || 0,
    })),
    alerts: alerts.map((a) => ({
      severity: a.severity,
      uid: a.uid,
      type: a.alert_type,
      message: a.message,
      last_seen_iso: a.last_seen_iso,
    })),
  };
}

async function poll() {
  const token = await login();
  const health = await getHealth(token);
  const summary = summarize(health);
  console.log(JSON.stringify(summary));
  const hasCritical = (health.alerts || []).some((a) => a.severity === 'critical');
  if (once && hasCritical) process.exitCode = 1;
}

async function main() {
  do {
    try {
      await poll();
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), error: err.message || String(err) }));
      if (once) process.exitCode = 1;
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  } while (!once);
}

main();
