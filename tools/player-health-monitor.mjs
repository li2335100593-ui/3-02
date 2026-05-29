#!/usr/bin/env node

const base = process.env.ANALYTICS_BASE || 'https://exposure-analytics.li2335100593.workers.dev';
const username = process.env.REPORT_USER;
const password = process.env.REPORT_PASS;
const intervalSec = Number(process.env.MONITOR_INTERVAL_SEC || 60);
const once = process.argv.includes('--once');
const serverchanSendkey = process.env.SERVERCHAN_SENDKEY || '';
const notifyRepeatMinutes = Number(process.env.MONITOR_NOTIFY_REPEAT_MINUTES || 60);
const requiredUids = splitEnv(process.env.MONITOR_REQUIRED_UIDS);
const requiredUrls = splitEnv(process.env.MONITOR_REQUIRED_URLS);
const panelUrl = process.env.OPERATOR_PANEL_URL || 'https://li2335100593-ui.github.io/3-02/operator-report.html';

if (!username || !password) {
  console.error('REPORT_USER and REPORT_PASS are required');
  process.exit(2);
}

function splitEnv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.ok === false) throw new Error(json.error || `${url} failed: ${res.status}`);
  return json;
}

async function login() {
  const json = await fetchJson(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!json.token) throw new Error('login response missing token');
  return json.token;
}

async function api(token, path, options = {}) {
  return fetchJson(`${base}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

async function ensureRequiredTargets(token) {
  if (!requiredUids.length) return;
  for (const uid of requiredUids) {
    await api(token, '/api/monitor-targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uid,
        label: 'GitHub Actions production monitor',
        expected_urls: requiredUrls,
        stale_after_sec: 300,
        note: 'Auto-registered by tools/player-health-monitor.mjs',
        is_enabled: true,
      }),
    });
  }
}

function summarize(health, alerts) {
  const players = health.players || [];
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
      dwell_seconds: p.today?.dwell_seconds || 0,
    })),
    alerts: alerts.map((a) => ({
      id: a.id,
      severity: a.severity,
      uid: a.uid,
      type: a.alert_type,
      message: a.message,
      notified_iso: a.notified_iso,
      last_seen_iso: a.last_seen_iso,
    })),
  };
}

function requiredProblems(health) {
  const problems = [];
  const players = new Map((health.players || []).map((p) => [p.uid, p]));
  for (const uid of requiredUids) {
    const player = players.get(uid);
    if (!player) {
      problems.push({ severity: 'critical', uid, type: 'required_uid_missing', message: `${uid} 没有任何健康状态` });
      continue;
    }
    if (player.health !== 'online') {
      problems.push({ severity: player.severity || 'warning', uid, type: 'required_uid_not_online', message: `${uid} 当前状态为 ${player.health}` });
    }
    const seenUrls = new Set((player.today?.urls || []).map((u) => u.url));
    const missing = requiredUrls.filter((u) => !seenUrls.has(u));
    if (missing.length) {
      problems.push({ severity: 'warning', uid, type: 'required_url_missing', message: `${uid} 今日缺少 ${missing.length} 个预期站点`, details: { missing } });
    }
  }
  return problems;
}

function shouldNotify(alert) {
  if (!alert.id) return true;
  if (!alert.notified_at) return true;
  return Date.now() - Number(alert.notified_at) > notifyRepeatMinutes * 60 * 1000;
}

function formatProblem(p) {
  const details = p.details ? `\n\nDetails:\n\`\`\`json\n${JSON.stringify(p.details, null, 2)}\n\`\`\`` : '';
  return `- [${p.severity}] ${p.uid || 'system'} ${p.type || p.alert_type}: ${p.message}${details}`;
}

async function sendServerchan(title, desp) {
  if (!serverchanSendkey) throw new Error('SERVERCHAN_SENDKEY is not configured');
  const body = new URLSearchParams({ title, desp });
  const json = await fetchJson(`https://sctapi.ftqq.com/${serverchanSendkey}.send`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  return json;
}

async function markNotified(token, alerts, error = null) {
  const ids = alerts.map((a) => a.id).filter(Boolean);
  if (!ids.length) return;
  await api(token, '/api/alerts/mark-notified', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, channel: 'serverchan', error }),
  });
}

async function poll() {
  const token = await login();
  await ensureRequiredTargets(token);
  const health = await api(token, '/api/player-health');
  const alertsJson = await api(token, '/api/alerts?status=open&limit=300');
  const openAlerts = alertsJson.alerts || [];
  const problems = [...openAlerts, ...requiredProblems(health)];
  const summary = summarize(health, openAlerts);
  console.log(JSON.stringify({ ...summary, problem_count: problems.length }));

  const notifiable = openAlerts.filter(shouldNotify);
  const synthetic = problems.filter((p) => !p.id);
  if ((notifiable.length || synthetic.length) && serverchanSendkey) {
    const title = `[GAM轮播告警] ${problems.some((p) => p.severity === 'critical') ? 'critical' : 'warning'} ${problems[0]?.uid || 'system'}`;
    const desp = [
      `时间: ${new Date().toISOString()}`,
      `面板: ${panelUrl}`,
      '',
      ...problems.map(formatProblem),
    ].join('\n');
    try {
      await sendServerchan(title, desp);
      await markNotified(token, notifiable);
    } catch (err) {
      await markNotified(token, notifiable, err.message || String(err));
      throw err;
    }
  }

  if (once && problems.length) process.exitCode = 1;
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
