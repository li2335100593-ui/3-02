function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function csv(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=exposure-report.csv",
      ...extraHeaders,
    },
  });
}

function corsHeaders(origin = "*") {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-internal-token",
    "access-control-max-age": "86400",
  };
}

function parseDeviceType(ua) {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
  if (/(ipad|tablet)/.test(lower)) return "tablet";
  if (/(iphone|android|mobile)/.test(lower)) return "mobile";
  if (/(macintosh|windows|linux|x11)/.test(lower)) return "desktop";
  return "unknown";
}

function exposureFilterSql() {
  return "(event_type = 'page_enter' OR event_type IS NULL)";
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseReportRange(url) {
  const now = Date.now();
  const from = toInt(url.searchParams.get("from"), now - 24 * 60 * 60 * 1000);
  const to = toInt(url.searchParams.get("to"), now);
  if (from >= to) {
    return { error: "`from` must be smaller than `to`." };
  }
  return { from, to };
}

function escapeCsv(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function handleExposure(req, env, headers) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400, headers);
  }

  const now = Date.now();
  const ua = req.headers.get("user-agent") || "";
  const ip = req.headers.get("cf-connecting-ip") || null;
  const eventType = body.event_type || "page_enter";
  const url = body.url || null;

  if (!url) {
    return json({ ok: false, error: "`url` is required" }, 400, headers);
  }

  const id = body.id || crypto.randomUUID();
  const deviceType = body.device_type || parseDeviceType(ua);

  await env.DB.prepare(
    `INSERT INTO exposure_events (
      id, event_type, sid, vid, url, page_index, ip, user_agent, device_type, client_ts, dwell_ms, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      eventType,
      body.sid || null,
      body.vid || null,
      url,
      body.page_index == null ? null : Number(body.page_index),
      ip,
      ua,
      deviceType,
      body.client_ts == null ? null : Number(body.client_ts),
      body.dwell_ms == null ? null : Number(body.dwell_ms),
      now
    )
    .run();

  return json({ ok: true, id, received_at: now }, 200, headers);
}

async function getSummary(env, from, to) {
  return env.DB.prepare(
    `SELECT
      COUNT(*) AS total_exposures,
      COUNT(DISTINCT sid) AS unique_sessions,
      COUNT(DISTINCT ip) AS unique_ips
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND ${exposureFilterSql()}`
  )
    .bind(from, to)
    .first();
}

async function getByUrl(env, from, to) {
  const result = await env.DB.prepare(
    `SELECT url, COUNT(*) AS exposures
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND ${exposureFilterSql()}
    GROUP BY url
    ORDER BY exposures DESC, url ASC`
  )
    .bind(from, to)
    .all();
  return result.results || [];
}

async function getByDevice(env, from, to, selectedUrl = null) {
  let sql = `SELECT device_type, COUNT(*) AS exposures
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND ${exposureFilterSql()}`;
  const params = [from, to];
  if (selectedUrl) {
    sql += " AND url = ?";
    params.push(selectedUrl);
  }
  sql += " GROUP BY device_type ORDER BY exposures DESC, device_type ASC";

  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all();
  return result.results || [];
}

async function getPerUrlDetails(env, from, to, selectedUrl, page, pageSize) {
  if (!selectedUrl) return null;

  const detailBase = await env.DB.prepare(
    `SELECT
      COUNT(*) AS exposures,
      COUNT(DISTINCT ip) AS unique_ips
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND url = ? AND ${exposureFilterSql()}`
  )
    .bind(from, to, selectedUrl)
    .first();

  const dailyRepeatRes = await env.DB.prepare(
    `WITH per_ip_day AS (
      SELECT
        date(received_at / 1000, 'unixepoch', 'localtime') AS day,
        ip,
        COUNT(*) AS hits
      FROM exposure_events
      WHERE received_at >= ?
        AND received_at <= ?
        AND url = ?
        AND ${exposureFilterSql()}
        AND ip IS NOT NULL
        AND ip <> ''
      GROUP BY day, ip
    )
    SELECT
      day,
      COUNT(*) AS repeat_ips,
      COALESCE(SUM(hits), 0) AS repeat_exposures
    FROM per_ip_day
    WHERE hits >= 2
    GROUP BY day
    ORDER BY day DESC`
  )
    .bind(from, to, selectedUrl)
    .all();

  const dailyRepeat = (dailyRepeatRes.results || []).map((r) => ({
    day: r.day,
    repeat_ips: Number(r.repeat_ips || 0),
    repeat_exposures: Number(r.repeat_exposures || 0),
  }));

  const totalRepeatedIpDays = dailyRepeat.reduce((acc, r) => acc + r.repeat_ips, 0);

  const byDevice = await getByDevice(env, from, to, selectedUrl);

  const totalUsersRes = await env.DB.prepare(
    `SELECT COUNT(DISTINCT vid) AS total_user_ids
    FROM exposure_events
    WHERE received_at >= ?
      AND received_at <= ?
      AND url = ?
      AND ${exposureFilterSql()}
      AND vid IS NOT NULL
      AND vid <> ''`
  )
    .bind(from, to, selectedUrl)
    .first();

  const offset = (page - 1) * pageSize;
  const userRes = await env.DB.prepare(
    `SELECT
      vid AS user_id,
      COUNT(*) AS exposures
    FROM exposure_events
    WHERE received_at >= ?
      AND received_at <= ?
      AND url = ?
      AND ${exposureFilterSql()}
      AND vid IS NOT NULL
      AND vid <> ''
    GROUP BY vid
    ORDER BY exposures DESC, user_id ASC
    LIMIT ? OFFSET ?`
  )
    .bind(from, to, selectedUrl, pageSize, offset)
    .all();

  return {
    url: selectedUrl,
    exposures: Number(detailBase?.exposures || 0),
    unique_ips: Number(detailBase?.unique_ips || 0),
    repeated_ip_days_total: Number(totalRepeatedIpDays || 0),
    daily_repeat_ip: dailyRepeat,
    by_device: byDevice.map((r) => ({
      device_type: r.device_type || "unknown",
      exposures: Number(r.exposures || 0),
    })),
    user_ids: (userRes.results || []).map((r) => r.user_id),
    total_user_ids: Number(totalUsersRes?.total_user_ids || 0),
    page,
    page_size: pageSize,
  };
}

async function handleReport(req, env, headers) {
  const url = new URL(req.url);
  const range = parseReportRange(url);
  if (range.error) {
    return json({ ok: false, error: range.error }, 400, headers);
  }

  const selectedUrl = url.searchParams.get("url") || null;
  const page = Math.max(1, toInt(url.searchParams.get("page"), 1));
  const pageSize = Math.min(200, Math.max(1, toInt(url.searchParams.get("page_size"), 50)));

  const [summary, byUrl, byDevice, perUrlDetails] = await Promise.all([
    getSummary(env, range.from, range.to),
    getByUrl(env, range.from, range.to),
    getByDevice(env, range.from, range.to),
    getPerUrlDetails(env, range.from, range.to, selectedUrl, page, pageSize),
  ]);

  return json(
    {
      ok: true,
      range: { from: range.from, to: range.to },
      summary: {
        total_exposures: Number(summary?.total_exposures || 0),
        unique_sessions: Number(summary?.unique_sessions || 0),
        unique_ips: Number(summary?.unique_ips || 0),
      },
      by_url: byUrl.map((r) => ({
        url: r.url,
        exposures: Number(r.exposures || 0),
      })),
      by_device: byDevice.map((r) => ({
        device_type: r.device_type || "unknown",
        exposures: Number(r.exposures || 0),
      })),
      per_url_details: perUrlDetails,
    },
    200,
    headers
  );
}

async function handleCsv(req, env, headers) {
  const url = new URL(req.url);
  const range = parseReportRange(url);
  if (range.error) {
    return csv(`error\n${escapeCsv(range.error)}\n`, 400, headers);
  }

  const selectedUrl = url.searchParams.get("url") || null;

  if (!selectedUrl) {
    const byUrl = await getByUrl(env, range.from, range.to);
    const lines = ["url,exposures"];
    for (const row of byUrl) {
      lines.push(`${escapeCsv(row.url)},${Number(row.exposures || 0)}`);
    }
    return csv(lines.join("\n") + "\n", 200, headers);
  }

  const detail = await getPerUrlDetails(env, range.from, range.to, selectedUrl, 1, 1000);
  const lines = [
    "section,url,metric,value",
    `${escapeCsv("summary")},${escapeCsv(selectedUrl)},${escapeCsv("exposures")},${detail.exposures}`,
    `${escapeCsv("summary")},${escapeCsv(selectedUrl)},${escapeCsv("unique_ips")},${detail.unique_ips}`,
    `${escapeCsv("summary")},${escapeCsv(selectedUrl)},${escapeCsv("repeated_ip_days_total")},${detail.repeated_ip_days_total}`,
  ];

  for (const d of detail.daily_repeat_ip) {
    lines.push(
      `${escapeCsv("daily_repeat_ip")},${escapeCsv(selectedUrl)},${escapeCsv(d.day)},${escapeCsv(
        `${d.repeat_ips}|${d.repeat_exposures}`
      )}`
    );
  }

  for (const dv of detail.by_device) {
    lines.push(
      `${escapeCsv("device")},${escapeCsv(selectedUrl)},${escapeCsv(dv.device_type)},${dv.exposures}`
    );
  }

  for (const userId of detail.user_ids) {
    lines.push(`${escapeCsv("user_id")},${escapeCsv(selectedUrl)},${escapeCsv(userId)},1`);
  }

  return csv(lines.join("\n") + "\n", 200, headers);
}

function checkInternalToken(req, env) {
  const token = env.REPORT_API_TOKEN;
  if (!token) return true;
  const incoming = req.headers.get("x-internal-token");
  return incoming === token;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "*";
    const headers = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(req.url);

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, now: Date.now() }, 200, headers);
      }

      if (url.pathname === "/api/exposure" && req.method === "POST") {
        return await handleExposure(req, env, headers);
      }

      if ((url.pathname === "/api/report" || url.pathname === "/api/report.csv") && !checkInternalToken(req, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401, headers);
      }

      if (url.pathname === "/api/report" && req.method === "GET") {
        return await handleReport(req, env, headers);
      }

      if (url.pathname === "/api/report.csv" && req.method === "GET") {
        return await handleCsv(req, env, headers);
      }

      return json({ ok: false, error: "Not Found" }, 404, headers);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : "Internal Error" }, 500, headers);
    }
  },
};
