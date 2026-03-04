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

function normalizeUrl(v) {
  if (!v) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
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

function parseUrlFilters(url) {
  const selected = [];
  const single = normalizeUrl(url.searchParams.get("url"));
  if (single) selected.push(single);

  const multiRaw = url.searchParams.get("urls");
  if (multiRaw) {
    for (const part of multiRaw.split(",")) {
      const cleaned = normalizeUrl(decodeURIComponent(part));
      if (cleaned) selected.push(cleaned);
    }
  }

  return [...new Set(selected)];
}

function makeSqlInClause(values) {
  if (!values || values.length === 0) return { clause: "", params: [] };
  const placeholders = values.map(() => "?").join(",");
  return {
    clause: ` AND url IN (${placeholders})`,
    params: values,
  };
}

function toIsoOrNull(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function rootLikePattern(rootUrl) {
  if (!rootUrl) return "%";
  return rootUrl.endsWith("/") ? `${rootUrl}%` : `${rootUrl}/%`;
}

function buildUrlScopeClause(selectedUrls, configuredUrls) {
  if (!selectedUrls || selectedUrls.length === 0) {
    return { clause: "", params: [] };
  }

  const roots = new Set(configuredUrls || []);
  const parts = [];
  const params = [];

  for (const u of selectedUrls) {
    if (roots.has(u)) {
      parts.push("(url = ? OR url LIKE ?)");
      params.push(u, rootLikePattern(u));
    } else {
      parts.push("url = ?");
      params.push(u);
    }
  }

  return {
    clause: ` AND (${parts.join(" OR ")})`,
    params,
  };
}

function escapeCsv(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function upsertConfiguredUrls(env, urls, source = "scheduler") {
  const now = Date.now();
  await env.DB.prepare(`UPDATE configured_urls SET is_active = 0, updated_at = ? WHERE source = ?`)
    .bind(now, source)
    .run();

  for (const raw of urls) {
    const url = normalizeUrl(raw);
    if (!url) continue;
    await env.DB.prepare(
      `INSERT INTO configured_urls (url, source, is_active, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(url) DO UPDATE SET
         source = excluded.source,
         is_active = 1,
         updated_at = excluded.updated_at`
    )
      .bind(url, source, now)
      .run();
  }
}

async function getConfiguredUrls(env) {
  const res = await env.DB.prepare(
    `SELECT url FROM configured_urls WHERE is_active = 1 ORDER BY url ASC`
  ).all();
  return (res.results || []).map((r) => r.url).filter(Boolean);
}

async function handleConfigUrls(req, env, headers) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400, headers);
  }

  const urls = Array.isArray(body?.urls) ? body.urls : [];
  if (urls.length === 0) {
    return json({ ok: false, error: "`urls` must be a non-empty array" }, 400, headers);
  }

  await upsertConfiguredUrls(env, urls, body?.source || "scheduler");
  return json({ ok: true, total_urls: urls.length }, 200, headers);
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
  const url = normalizeUrl(body.url);

  if (!url) {
    return json({ ok: false, error: "`url` is required" }, 400, headers);
  }

  const deviceType = body.device_type || parseDeviceType(ua);
  const insertRes = await env.DB.prepare(
    `INSERT INTO exposure_events (
      event_type, sid, vid, url, page_index, ip, ua, device_type, client_ts, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      eventType,
      body.sid || null,
      body.vid || null,
      url,
      body.page_index == null ? null : Number(body.page_index),
      ip,
      ua,
      deviceType,
      body.client_ts == null ? null : Number(body.client_ts),
      now
    )
    .run();

  return json({ ok: true, id: insertRes?.meta?.last_row_id ?? null, received_at: now }, 200, headers);
}

async function getSummaryForUrls(env, from, to, selectedUrls) {
  const configuredUrls = await getConfiguredUrls(env);
  const inClause = buildUrlScopeClause(selectedUrls, configuredUrls);
  return env.DB.prepare(
    `SELECT
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS total_exposures,
      COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN sid END) AS unique_sessions,
      COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN ip END) AS unique_ips
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?${inClause.clause}`
  )
    .bind(from, to, ...inClause.params)
    .first();
}

async function getByUrlRaw(env, from, to, selectedUrls = []) {
  const configuredUrls = await getConfiguredUrls(env);
  const inClause = buildUrlScopeClause(selectedUrls, configuredUrls);
  const result = await env.DB.prepare(
    `WITH filtered AS (
      SELECT *
      FROM exposure_events
      WHERE received_at >= ? AND received_at <= ?${inClause.clause}
    ),
    base AS (
      SELECT
        url,
        SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS exposures,
        COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN ip END) AS unique_ips,
        SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeat_events,
        SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS enter_events,
        MAX(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN received_at ELSE NULL END) AS last_exposure_time
      FROM filtered
      GROUP BY url
    ),
    repeat_day AS (
      SELECT url, day, COUNT(*) AS repeat_ips
      FROM (
        SELECT
          url,
          date(received_at / 1000, 'unixepoch', '+8 hours') AS day,
          ip,
          COUNT(*) AS hits
        FROM filtered
        WHERE (event_type = 'page_enter' OR event_type IS NULL)
          AND ip IS NOT NULL
          AND ip <> ''
        GROUP BY url, day, ip
      ) t
      WHERE hits >= 2
      GROUP BY url, day
    )
    SELECT
      b.url,
      b.exposures,
      b.unique_ips,
      COALESCE((SELECT SUM(rd.repeat_ips) FROM repeat_day rd WHERE rd.url = b.url), 0) AS daily_repeated_ips,
      COALESCE((
        SELECT f2.device_type
        FROM filtered f2
        WHERE f2.url = b.url
          AND (f2.event_type = 'page_enter' OR f2.event_type IS NULL)
        GROUP BY f2.device_type
        ORDER BY COUNT(*) DESC, f2.device_type ASC
        LIMIT 1
      ), 'unknown') AS primary_device_type,
      b.last_exposure_time,
      CASE
        WHEN b.enter_events > 0 THEN ROUND((CAST(b.heartbeat_events AS REAL) / b.enter_events), 4)
        ELSE 0
      END AS engagement_ratio
    FROM base b
    ORDER BY b.exposures DESC, b.url ASC`
  )
    .bind(from, to, ...inClause.params)
    .all();
  return result.results || [];
}

async function getRowsByConfiguredRoot(env, from, to, configuredUrls, selectedUrls = []) {
  const targetRoots = selectedUrls.length > 0
    ? selectedUrls.filter((u) => configuredUrls.includes(u))
    : configuredUrls;

  if (!targetRoots || targetRoots.length === 0) return [];

  const out = [];
  for (const rootUrl of targetRoots) {
    const like = rootLikePattern(rootUrl);
    const row = await env.DB.prepare(
      `WITH scoped AS (
        SELECT *
        FROM exposure_events
        WHERE received_at >= ?
          AND received_at <= ?
          AND (url = ? OR url LIKE ?)
      ),
      repeat_day AS (
        SELECT day, COUNT(*) AS repeat_ips
        FROM (
          SELECT
            date(received_at / 1000, 'unixepoch', '+8 hours') AS day,
            ip,
            COUNT(*) AS hits
          FROM scoped
          WHERE ${exposureFilterSql()}
            AND ip IS NOT NULL
            AND ip <> ''
          GROUP BY day, ip
        ) t
        WHERE hits >= 2
        GROUP BY day
      )
      SELECT
        ? AS url,
        SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS exposures,
        COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN ip END) AS unique_ips,
        COALESCE((SELECT SUM(repeat_ips) FROM repeat_day), 0) AS daily_repeated_ips,
        COALESCE((
          SELECT device_type
          FROM scoped
          WHERE event_type = 'page_enter' OR event_type IS NULL
          GROUP BY device_type
          ORDER BY COUNT(*) DESC, device_type ASC
          LIMIT 1
        ), 'unknown') AS primary_device_type,
        CASE
          WHEN SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) > 0
          THEN ROUND(
            CAST(SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) AS REAL) /
            SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END),
            4
          )
          ELSE 0
        END AS engagement_ratio,
        MAX(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN received_at ELSE NULL END) AS last_exposure_time
      FROM scoped`
    )
      .bind(from, to, rootUrl, like, rootUrl)
      .first();

    out.push({
      url: rootUrl,
      exposures: Number(row?.exposures || 0),
      unique_ips: Number(row?.unique_ips || 0),
      daily_repeated_ips: Number(row?.daily_repeated_ips || 0),
      primary_device_type: row?.primary_device_type || "unknown",
      engagement_ratio: Number(row?.engagement_ratio || 0),
      last_exposure_time: Number(row?.last_exposure_time || 0),
      last_exposure_iso: toIsoOrNull(row?.last_exposure_time),
    });
  }

  out.sort((a, b) => {
    if (b.exposures !== a.exposures) return b.exposures - a.exposures;
    return a.url.localeCompare(b.url);
  });
  return out;
}

function mergeByUrlWithUniverse(configuredUrls, byUrlRaw, selectedUrls = []) {
  const metricMap = new Map();
  for (const row of byUrlRaw) {
    metricMap.set(row.url, {
      url: row.url,
      exposures: Number(row.exposures || 0),
      unique_ips: Number(row.unique_ips || 0),
      daily_repeated_ips: Number(row.daily_repeated_ips || 0),
      primary_device_type: row.primary_device_type || "unknown",
      engagement_ratio: Number(row.engagement_ratio || 0),
      last_exposure_time: Number(row.last_exposure_time || 0),
      last_exposure_iso: toIsoOrNull(row.last_exposure_time),
    });
  }

  const universe = new Set();
  if (selectedUrls.length > 0) {
    selectedUrls.forEach((u) => universe.add(u));
  } else {
    configuredUrls.forEach((u) => universe.add(u));
    for (const row of byUrlRaw) universe.add(row.url);
  }

  const merged = [];
  for (const url of universe) {
    const row = metricMap.get(url);
    if (row) {
      merged.push(row);
    } else {
      merged.push({
        url,
        exposures: 0,
        unique_ips: 0,
        daily_repeated_ips: 0,
        primary_device_type: "unknown",
        engagement_ratio: 0,
        last_exposure_time: 0,
        last_exposure_iso: null,
      });
    }
  }

  merged.sort((a, b) => {
    if (b.exposures !== a.exposures) return b.exposures - a.exposures;
    return a.url.localeCompare(b.url);
  });

  return merged;
}

async function getByDevice(env, from, to, selectedUrl = null, selectedUrls = []) {
  const configuredUrls = await getConfiguredUrls(env);
  const inClause = buildUrlScopeClause(selectedUrls, configuredUrls);
  let sql = `SELECT device_type, COUNT(*) AS exposures
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND ${exposureFilterSql()}${inClause.clause}`;
  const params = [from, to, ...inClause.params];

  if (selectedUrl) {
    sql += " AND url = ?";
    params.push(selectedUrl);
  }
  sql += " GROUP BY device_type ORDER BY exposures DESC, device_type ASC";

  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}

async function getPerUrlDetails(env, from, to, selectedUrl, page, pageSize) {
  if (!selectedUrl) return null;

  const configuredUrls = await getConfiguredUrls(env);
  const isRoot = configuredUrls.includes(selectedUrl);
  const rootLike = rootLikePattern(selectedUrl);
  const detailScopeClause = isRoot ? "(url = ? OR url LIKE ?)" : "url = ?";
  const detailScopeParams = isRoot ? [selectedUrl, rootLike] : [selectedUrl];

  const detailBase = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS exposures,
      COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN ip END) AS unique_ips
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND ${detailScopeClause}`
  )
    .bind(from, to, ...detailScopeParams)
    .first();

  const dailyRepeatRes = await env.DB.prepare(
    `WITH per_ip_day AS (
      SELECT
        date(received_at / 1000, 'unixepoch', '+8 hours') AS day,
        ip,
        COUNT(*) AS hits
      FROM exposure_events
      WHERE received_at >= ?
        AND received_at <= ?
        AND ${detailScopeClause}
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
    .bind(from, to, ...detailScopeParams)
    .all();

  const dailyRepeat = (dailyRepeatRes.results || []).map((r) => ({
    day: r.day,
    repeat_ips: Number(r.repeat_ips || 0),
    repeat_exposures: Number(r.repeat_exposures || 0),
  }));

  const totalRepeatedIpDays = dailyRepeat.reduce((acc, r) => acc + r.repeat_ips, 0);
  const byDevice = await getByDevice(env, from, to, null, [selectedUrl]);

  const totalUsersRes = await env.DB.prepare(
    `SELECT COUNT(DISTINCT vid) AS total_user_ids
    FROM exposure_events
    WHERE received_at >= ?
      AND received_at <= ?
      AND ${detailScopeClause}
      AND ${exposureFilterSql()}
      AND vid IS NOT NULL
      AND vid <> ''`
  )
    .bind(from, to, ...detailScopeParams)
    .first();

  const offset = (page - 1) * pageSize;
  const userRes = await env.DB.prepare(
    `SELECT vid AS user_id, COUNT(*) AS exposures
    FROM exposure_events
    WHERE received_at >= ?
      AND received_at <= ?
      AND ${detailScopeClause}
      AND ${exposureFilterSql()}
      AND vid IS NOT NULL
      AND vid <> ''
    GROUP BY vid
    ORDER BY exposures DESC, user_id ASC
    LIMIT ? OFFSET ?`
  )
    .bind(from, to, ...detailScopeParams, pageSize, offset)
    .all();

  const subPageRes = await env.DB.prepare(
    `SELECT
      url,
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS exposures,
      COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN ip END) AS unique_ips,
      MAX(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN received_at ELSE NULL END) AS last_exposure_time
    FROM exposure_events
    WHERE received_at >= ?
      AND received_at <= ?
      AND ${detailScopeClause}
    GROUP BY url
    ORDER BY exposures DESC, url ASC
    LIMIT 50`
  )
    .bind(from, to, ...detailScopeParams)
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
    sub_pages: (subPageRes.results || []).map((r) => ({
      url: r.url,
      exposures: Number(r.exposures || 0),
      unique_ips: Number(r.unique_ips || 0),
      last_exposure_time: Number(r.last_exposure_time || 0),
      last_exposure_iso: toIsoOrNull(r.last_exposure_time),
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
  if (range.error) return json({ ok: false, error: range.error }, 400, headers);

  const selectedUrls = parseUrlFilters(url);
  const selectedUrl = selectedUrls.length > 0 ? selectedUrls[0] : null;
  const page = Math.max(1, toInt(url.searchParams.get("page"), 1));
  const pageSize = Math.min(200, Math.max(1, toInt(url.searchParams.get("page_size"), 50)));

  const [configuredUrls, summary, byDevice, perUrlDetails] = await Promise.all([
    getConfiguredUrls(env),
    getSummaryForUrls(env, range.from, range.to, selectedUrls),
    getByDevice(env, range.from, range.to, null, selectedUrls),
    getPerUrlDetails(env, range.from, range.to, selectedUrl, page, pageSize),
  ]);

  const byUrl = await getRowsByConfiguredRoot(env, range.from, range.to, configuredUrls, selectedUrls);

  return json(
    {
      ok: true,
      range: { from: range.from, to: range.to },
      applied_filters: { urls: selectedUrls },
      configured_urls: configuredUrls,
      summary: {
        total_exposures: Number(summary?.total_exposures || 0),
        unique_sessions: Number(summary?.unique_sessions || 0),
        unique_ips: Number(summary?.unique_ips || 0),
      },
      by_url: byUrl,
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
  if (range.error) return csv(`error\n${escapeCsv(range.error)}\n`, 400, headers);

  const selectedUrls = parseUrlFilters(url);
  const selectedUrl = selectedUrls.length > 0 ? selectedUrls[0] : null;

  if (!selectedUrl) {
    const configuredUrls = await getConfiguredUrls(env);
    const byUrl = await getRowsByConfiguredRoot(env, range.from, range.to, configuredUrls, selectedUrls);
    const lines = [
      "url,exposures,unique_ips,daily_repeated_ips,primary_device_type,engagement_ratio,last_exposure_time",
    ];
    for (const row of byUrl) {
      lines.push([
        escapeCsv(row.url),
        Number(row.exposures || 0),
        Number(row.unique_ips || 0),
        Number(row.daily_repeated_ips || 0),
        escapeCsv(row.primary_device_type || "unknown"),
        Number(row.engagement_ratio || 0),
        escapeCsv(row.last_exposure_iso || ""),
      ].join(","));
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
    lines.push(`${escapeCsv("device")},${escapeCsv(selectedUrl)},${escapeCsv(dv.device_type)},${dv.exposures}`);
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

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, now: Date.now() }, 200, headers);
      if (url.pathname === "/api/exposure" && req.method === "POST") return await handleExposure(req, env, headers);
      if (url.pathname === "/api/config/urls" && req.method === "POST") return await handleConfigUrls(req, env, headers);

      if ((url.pathname === "/api/report" || url.pathname === "/api/report.csv") && !checkInternalToken(req, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401, headers);
      }

      if (url.pathname === "/api/report" && req.method === "GET") return await handleReport(req, env, headers);
      if (url.pathname === "/api/report.csv" && req.method === "GET") return await handleCsv(req, env, headers);

      return json({ ok: false, error: "Not Found" }, 404, headers);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : "Internal Error" }, 500, headers);
    }
  },
};
