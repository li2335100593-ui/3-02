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
  // Analytics + report endpoints are intentionally domain-agnostic: this system
  // is embedded on arbitrary customer sites and reports are loaded from any
  // admin host. Endpoints are write-only or use Bearer auth, never cookies,
  // so wildcard origin + explicit Authorization header is safe.
  return {
    "access-control-allow-origin": origin && origin !== "null" ? origin : "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-internal-token",
    "access-control-max-age": "86400",
    "vary": "origin",
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
  const screenW = Number.isFinite(Number(body.screen_w)) ? Number(body.screen_w) : null;
  const screenH = Number.isFinite(Number(body.screen_h)) ? Number(body.screen_h) : null;
  const tzOffset = Number.isFinite(Number(body.tz_offset)) ? Number(body.tz_offset) : null;
  const insertRes = await env.DB.prepare(
    `INSERT INTO exposure_events (
      event_type, sid, vid, uid, url, page_index, ip, ua, device_type,
      screen_w, screen_h, tz_offset, client_ts, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      eventType,
      body.sid || null,
      body.vid || null,
      body.uid || null,
      url,
      body.page_index == null ? null : Number(body.page_index),
      ip,
      ua,
      deviceType,
      screenW,
      screenH,
      tzOffset,
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
      COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN ip END) AS unique_ips,
      COUNT(DISTINCT CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN uid END) AS unique_users
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

async function getByUid(env, from, to, selectedUrls = []) {
  const configuredUrls = await getConfiguredUrls(env);
  const inClause = buildUrlScopeClause(selectedUrls, configuredUrls);
  const result = await env.DB.prepare(
    `SELECT
      COALESCE(uid, '(未指定)') AS uid,
      COUNT(*) AS total_events,
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS exposures,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeats,
      COUNT(DISTINCT sid) AS unique_sessions,
      COUNT(DISTINCT vid) AS unique_vids,
      MIN(received_at) AS first_seen,
      MAX(received_at) AS last_seen
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?${inClause.clause}
    GROUP BY uid
    ORDER BY exposures DESC, uid ASC`
  )
    .bind(from, to, ...inClause.params)
    .all();
  return result.results || [];
}

async function handleReport(req, env, headers) {
  const url = new URL(req.url);
  const range = parseReportRange(url);
  if (range.error) return json({ ok: false, error: range.error }, 400, headers);

  const selectedUrls = parseUrlFilters(url);
  const selectedUrl = selectedUrls.length > 0 ? selectedUrls[0] : null;
  const page = Math.max(1, toInt(url.searchParams.get("page"), 1));
  const pageSize = Math.min(200, Math.max(1, toInt(url.searchParams.get("page_size"), 50)));

  const [configuredUrls, summary, byDevice, perUrlDetails, byUid] = await Promise.all([
    getConfiguredUrls(env),
    getSummaryForUrls(env, range.from, range.to, selectedUrls),
    getByDevice(env, range.from, range.to, null, selectedUrls),
    getPerUrlDetails(env, range.from, range.to, selectedUrl, page, pageSize),
    getByUid(env, range.from, range.to, selectedUrls),
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
        unique_users: Number(summary?.unique_users || 0),
      },
      by_url: byUrl,
      by_device: byDevice.map((r) => ({
        device_type: r.device_type || "unknown",
        exposures: Number(r.exposures || 0),
      })),
      by_uid: byUid.map((r) => ({
        uid: r.uid || "(未指定)",
        total_events: Number(r.total_events || 0),
        exposures: Number(r.exposures || 0),
        heartbeats: Number(r.heartbeats || 0),
        unique_sessions: Number(r.unique_sessions || 0),
        unique_vids: Number(r.unique_vids || 0),
        first_seen: Number(r.first_seen || 0),
        last_seen: Number(r.last_seen || 0),
        first_seen_iso: toIsoOrNull(r.first_seen),
        last_seen_iso: toIsoOrNull(r.last_seen),
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
  // Authentication disabled - report endpoints are now public
  return true;
}

// ===== Operator-centric report =====
// Heartbeats fire every HEARTBEAT_INTERVAL_SEC (30s) on each tracked page.
// Working time = heartbeat_count * HEARTBEAT_INTERVAL_SEC. This is conservative:
// it undercounts by up to 30s per session (we don't credit time before the first
// heartbeat fires), which is the right bias for payroll / billing disputes.
const HEARTBEAT_INTERVAL_SEC = 30;

async function getOperatorSummaries(env, from, to) {
  const result = await env.DB.prepare(
    `SELECT
      uid,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      COUNT(DISTINCT sid) AS sessions,
      COUNT(DISTINCT date(received_at / 1000, 'unixepoch', '+8 hours')) AS active_days,
      COUNT(DISTINCT url) AS urls_visited,
      COUNT(DISTINCT vid) AS unique_devices,
      MIN(received_at) AS first_seen,
      MAX(received_at) AS last_seen,
      (
        SELECT device_type FROM exposure_events e2
        WHERE e2.uid = exposure_events.uid
          AND e2.received_at >= ? AND e2.received_at <= ?
          AND e2.device_type IS NOT NULL
        GROUP BY device_type
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) AS primary_device_type
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?
      AND uid IS NOT NULL AND uid <> ''
    GROUP BY uid
    ORDER BY dwell_seconds DESC, uid ASC`
  )
    .bind(from, to, from, to)
    .all();
  return (result.results || []).map((r) => ({
    uid: r.uid,
    dwell_seconds: Number(r.dwell_seconds || 0),
    sessions: Number(r.sessions || 0),
    active_days: Number(r.active_days || 0),
    urls_visited: Number(r.urls_visited || 0),
    unique_devices: Number(r.unique_devices || 0),
    primary_device_type: r.primary_device_type || "unknown",
    first_seen: Number(r.first_seen || 0),
    last_seen: Number(r.last_seen || 0),
    first_seen_iso: toIsoOrNull(r.first_seen),
    last_seen_iso: toIsoOrNull(r.last_seen),
  }));
}

async function getOperatorDailyDwell(env, from, to, uid) {
  const result = await env.DB.prepare(
    `SELECT
      date(received_at / 1000, 'unixepoch', '+8 hours') AS day,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      COUNT(DISTINCT sid) AS sessions,
      COUNT(DISTINCT url) AS urls_visited
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?
      AND uid = ?
    GROUP BY day
    ORDER BY day ASC`
  )
    .bind(from, to, uid)
    .all();
  return (result.results || []).map((r) => ({
    day: r.day,
    dwell_seconds: Number(r.dwell_seconds || 0),
    sessions: Number(r.sessions || 0),
    urls_visited: Number(r.urls_visited || 0),
  }));
}

async function getOperatorUrlBreakdown(env, from, to, uid) {
  const result = await env.DB.prepare(
    `SELECT
      url,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS visits,
      COUNT(DISTINCT sid) AS sessions,
      MAX(received_at) AS last_seen
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?
      AND uid = ?
    GROUP BY url
    ORDER BY dwell_seconds DESC, url ASC`
  )
    .bind(from, to, uid)
    .all();
  return (result.results || []).map((r) => ({
    url: r.url,
    dwell_seconds: Number(r.dwell_seconds || 0),
    visits: Number(r.visits || 0),
    sessions: Number(r.sessions || 0),
    last_seen: Number(r.last_seen || 0),
    last_seen_iso: toIsoOrNull(r.last_seen),
  }));
}

async function getOperatorSessions(env, from, to, uid) {
  const result = await env.DB.prepare(
    `SELECT
      sid,
      MIN(received_at) AS started_at,
      MAX(received_at) AS last_event_at,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS pages_visited,
      SUM(CASE WHEN event_type = 'page_leave' THEN 1 ELSE 0 END) AS clean_leaves,
      COUNT(DISTINCT url) AS unique_urls,
      (
        SELECT device_type FROM exposure_events e2
        WHERE e2.sid = exposure_events.sid AND e2.device_type IS NOT NULL
        LIMIT 1
      ) AS device_type,
      (
        SELECT vid FROM exposure_events e3
        WHERE e3.sid = exposure_events.sid AND e3.vid IS NOT NULL
        LIMIT 1
      ) AS vid,
      (
        SELECT ip FROM exposure_events e4
        WHERE e4.sid = exposure_events.sid AND e4.ip IS NOT NULL
        LIMIT 1
      ) AS ip,
      (
        SELECT screen_w FROM exposure_events e5
        WHERE e5.sid = exposure_events.sid AND e5.screen_w IS NOT NULL
        LIMIT 1
      ) AS screen_w,
      (
        SELECT screen_h FROM exposure_events e6
        WHERE e6.sid = exposure_events.sid AND e6.screen_h IS NOT NULL
        LIMIT 1
      ) AS screen_h,
      (
        SELECT ua FROM exposure_events e7
        WHERE e7.sid = exposure_events.sid AND e7.ua IS NOT NULL AND e7.ua <> ''
        LIMIT 1
      ) AS ua,
      (
        SELECT tz_offset FROM exposure_events e8
        WHERE e8.sid = exposure_events.sid AND e8.tz_offset IS NOT NULL
        LIMIT 1
      ) AS tz_offset
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?
      AND uid = ?
      AND sid IS NOT NULL
    GROUP BY sid
    ORDER BY started_at DESC
    LIMIT 200`
  )
    .bind(from, to, uid)
    .all();
  return (result.results || []).map((r) => ({
    sid: r.sid,
    started_at: Number(r.started_at || 0),
    last_event_at: Number(r.last_event_at || 0),
    started_iso: toIsoOrNull(r.started_at),
    last_event_iso: toIsoOrNull(r.last_event_at),
    dwell_seconds: Number(r.dwell_seconds || 0),
    pages_visited: Number(r.pages_visited || 0),
    clean_leaves: Number(r.clean_leaves || 0),
    unique_urls: Number(r.unique_urls || 0),
    device_type: r.device_type || "unknown",
    vid: r.vid || null,
    ip: r.ip || null,
    screen_w: r.screen_w == null ? null : Number(r.screen_w),
    screen_h: r.screen_h == null ? null : Number(r.screen_h),
    ua: r.ua || null,
    tz_offset: r.tz_offset == null ? null : Number(r.tz_offset),
  }));
}

// ===== Session-level event timeline =====
// Returns every page_enter/heartbeat/page_leave for one sid in chronological order.
// Used to render a per-session expandable timeline in the audit report.
async function handleSessionEvents(req, env, headers) {
  const url = new URL(req.url);
  const sid = url.searchParams.get("sid");
  if (!sid) return json({ ok: false, error: "sid is required" }, 400, headers);

  const result = await env.DB.prepare(
    `SELECT id, event_type, url, page_index, ip, ua, device_type,
            screen_w, screen_h, tz_offset, client_ts, received_at
     FROM exposure_events
     WHERE sid = ?
     ORDER BY received_at ASC, id ASC
     LIMIT 1000`
  ).bind(sid).all();

  const events = (result.results || []).map((r) => ({
    id: Number(r.id),
    event_type: r.event_type,
    url: r.url,
    page_index: r.page_index == null ? null : Number(r.page_index),
    ip: r.ip || null,
    ua: r.ua || null,
    device_type: r.device_type || null,
    screen_w: r.screen_w == null ? null : Number(r.screen_w),
    screen_h: r.screen_h == null ? null : Number(r.screen_h),
    tz_offset: r.tz_offset == null ? null : Number(r.tz_offset),
    client_ts: r.client_ts == null ? null : Number(r.client_ts),
    received_at: Number(r.received_at),
    received_iso: toIsoOrNull(r.received_at),
  }));

  // Compute per-page time blocks: group consecutive enter+heartbeats per url
  const pageBlocks = [];
  let block = null;
  for (const ev of events) {
    if (ev.event_type === 'page_enter' || (ev.event_type !== 'heartbeat' && ev.event_type !== 'page_leave')) {
      if (block) pageBlocks.push(block);
      block = {
        url: ev.url,
        started_at: ev.received_at,
        last_heartbeat_at: ev.received_at,
        heartbeat_count: 0,
        ended_at: null,
        end_reason: null,
      };
    } else if (ev.event_type === 'heartbeat' && block && ev.url === block.url) {
      block.heartbeat_count += 1;
      block.last_heartbeat_at = ev.received_at;
    } else if (ev.event_type === 'page_leave' && block && ev.url === block.url) {
      block.ended_at = ev.received_at;
      block.end_reason = 'normal';
    }
  }
  if (block) pageBlocks.push(block);

  for (const b of pageBlocks) {
    b.dwell_seconds = b.heartbeat_count * HEARTBEAT_INTERVAL_SEC;
    b.started_iso = toIsoOrNull(b.started_at);
    b.ended_iso = toIsoOrNull(b.ended_at);
    b.last_heartbeat_iso = toIsoOrNull(b.last_heartbeat_at);
    if (!b.end_reason) {
      b.end_reason = b.ended_at ? 'normal' : 'incomplete';
    }
  }

  return json({ ok: true, sid, events, pages: pageBlocks }, 200, headers);
}

async function handleOperatorReport(req, env, headers) {
  const url = new URL(req.url);
  const range = parseReportRange(url);
  if (range.error) return json({ ok: false, error: range.error }, 400, headers);

  const uid = normalizeUrl(url.searchParams.get("uid"));

  if (!uid) {
    const operators = await getOperatorSummaries(env, range.from, range.to);
    const totalDwell = operators.reduce((acc, op) => acc + op.dwell_seconds, 0);
    return json(
      {
        ok: true,
        range: { from: range.from, to: range.to },
        operators,
        totals: {
          operators: operators.length,
          dwell_seconds: totalDwell,
          dwell_hours: Math.round((totalDwell / 3600) * 100) / 100,
        },
      },
      200,
      headers
    );
  }

  const [summary, daily, urls, sessions] = await Promise.all([
    getOperatorSummaries(env, range.from, range.to).then((list) =>
      list.find((op) => op.uid === uid) || null
    ),
    getOperatorDailyDwell(env, range.from, range.to, uid),
    getOperatorUrlBreakdown(env, range.from, range.to, uid),
    getOperatorSessions(env, range.from, range.to, uid),
  ]);

  return json(
    {
      ok: true,
      range: { from: range.from, to: range.to },
      uid,
      summary,
      daily,
      by_url: urls,
      sessions,
    },
    200,
    headers
  );
}

// ===== Site-centric report (operator breakdown per URL) =====
async function getSiteSummaries(env, from, to) {
  const result = await env.DB.prepare(
    `SELECT
      url,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      SUM(CASE WHEN event_type = 'page_enter' OR event_type IS NULL THEN 1 ELSE 0 END) AS visits,
      COUNT(DISTINCT sid) AS sessions,
      COUNT(DISTINCT uid) AS unique_operators,
      COUNT(DISTINCT vid) AS unique_devices,
      COUNT(DISTINCT date(received_at / 1000, 'unixepoch', '+8 hours')) AS active_days,
      MAX(received_at) AS last_seen,
      (
        SELECT device_type FROM exposure_events e2
        WHERE e2.url = exposure_events.url
          AND e2.received_at >= ? AND e2.received_at <= ?
          AND e2.device_type IS NOT NULL
        GROUP BY device_type
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) AS primary_device_type
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?
    GROUP BY url
    ORDER BY dwell_seconds DESC, url ASC`
  )
    .bind(from, to, from, to)
    .all();
  return (result.results || []).map((r) => ({
    url: r.url,
    dwell_seconds: Number(r.dwell_seconds || 0),
    visits: Number(r.visits || 0),
    sessions: Number(r.sessions || 0),
    unique_operators: Number(r.unique_operators || 0),
    unique_devices: Number(r.unique_devices || 0),
    active_days: Number(r.active_days || 0),
    last_seen: Number(r.last_seen || 0),
    last_seen_iso: toIsoOrNull(r.last_seen),
    primary_device_type: r.primary_device_type || "unknown",
  }));
}

async function getSiteOperatorBreakdown(env, from, to, siteUrl) {
  const result = await env.DB.prepare(
    `SELECT
      uid,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      COUNT(DISTINCT sid) AS sessions,
      MAX(received_at) AS last_seen
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ?
      AND url = ?
      AND uid IS NOT NULL AND uid <> ''
    GROUP BY uid
    ORDER BY dwell_seconds DESC, uid ASC`
  )
    .bind(from, to, siteUrl)
    .all();
  return (result.results || []).map((r) => ({
    uid: r.uid,
    dwell_seconds: Number(r.dwell_seconds || 0),
    sessions: Number(r.sessions || 0),
    last_seen: Number(r.last_seen || 0),
    last_seen_iso: toIsoOrNull(r.last_seen),
  }));
}

async function getSiteDailyDwell(env, from, to, siteUrl) {
  const result = await env.DB.prepare(
    `SELECT
      date(received_at / 1000, 'unixepoch', '+8 hours') AS day,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds,
      COUNT(DISTINCT sid) AS sessions,
      COUNT(DISTINCT uid) AS operators
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND url = ?
    GROUP BY day
    ORDER BY day ASC`
  )
    .bind(from, to, siteUrl)
    .all();
  return (result.results || []).map((r) => ({
    day: r.day,
    dwell_seconds: Number(r.dwell_seconds || 0),
    sessions: Number(r.sessions || 0),
    operators: Number(r.operators || 0),
  }));
}

async function handleSiteReport(req, env, headers) {
  const url = new URL(req.url);
  const range = parseReportRange(url);
  if (range.error) return json({ ok: false, error: range.error }, 400, headers);

  const targetUrl = normalizeUrl(url.searchParams.get("url"));

  if (!targetUrl) {
    const sites = await getSiteSummaries(env, range.from, range.to);
    const totalDwell = sites.reduce((acc, s) => acc + s.dwell_seconds, 0);
    return json(
      {
        ok: true,
        range: { from: range.from, to: range.to },
        sites,
        totals: {
          sites: sites.length,
          dwell_seconds: totalDwell,
          dwell_hours: Math.round((totalDwell / 3600) * 100) / 100,
        },
      },
      200,
      headers
    );
  }

  const [summary, byOperator, daily] = await Promise.all([
    getSiteSummaries(env, range.from, range.to).then((list) => list.find((s) => s.url === targetUrl) || null),
    getSiteOperatorBreakdown(env, range.from, range.to, targetUrl),
    getSiteDailyDwell(env, range.from, range.to, targetUrl),
  ]);

  return json(
    {
      ok: true,
      range: { from: range.from, to: range.to },
      url: targetUrl,
      summary,
      by_operator: byOperator,
      daily,
    },
    200,
    headers
  );
}

// ===== Operator hour×weekday heatmap =====
// Returns a 7×24 matrix of dwell_seconds (rows = weekday 0-6, cols = hour 0-23).
// Uses Asia/Shanghai timezone via SQLite's built-in timezone shift.
async function handleOperatorHeatmap(req, env, headers) {
  const url = new URL(req.url);
  const range = parseReportRange(url);
  if (range.error) return json({ ok: false, error: range.error }, 400, headers);

  const uid = url.searchParams.get("uid");
  if (!uid) return json({ ok: false, error: "uid is required" }, 400, headers);

  const result = await env.DB.prepare(
    `SELECT
      CAST(strftime('%w', received_at / 1000, 'unixepoch', '+8 hours') AS INTEGER) AS weekday,
      CAST(strftime('%H', received_at / 1000, 'unixepoch', '+8 hours') AS INTEGER) AS hour,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) * ${HEARTBEAT_INTERVAL_SEC} AS dwell_seconds
    FROM exposure_events
    WHERE received_at >= ? AND received_at <= ? AND uid = ?
    GROUP BY weekday, hour
    ORDER BY weekday, hour`
  )
    .bind(range.from, range.to, uid)
    .all();

  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  let maxVal = 0;
  for (const r of result.results || []) {
    const w = Number(r.weekday);
    const h = Number(r.hour);
    const v = Number(r.dwell_seconds || 0);
    if (w >= 0 && w < 7 && h >= 0 && h < 24) {
      matrix[w][h] = v;
      if (v > maxVal) maxVal = v;
    }
  }
  return json({ ok: true, range: { from: range.from, to: range.to }, uid, matrix, max: maxVal }, 200, headers);
}

// ===== Sites management =====
async function handleSitesList(req, env, headers) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("all") === "1";
  const where = includeInactive ? "" : "WHERE is_active = 1";
  const result = await env.DB.prepare(
    `SELECT id, name, url, note, is_active, created_at, updated_at
     FROM sites ${where}
     ORDER BY created_at DESC, id DESC`
  ).all();
  return json(
    {
      ok: true,
      sites: (result.results || []).map((r) => ({
        id: Number(r.id),
        name: r.name,
        url: r.url,
        note: r.note || "",
        is_active: Number(r.is_active) === 1,
        created_at: Number(r.created_at),
        updated_at: Number(r.updated_at),
      })),
    },
    200,
    headers
  );
}

async function handleSitesAdd(req, env, headers) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400, headers); }

  const name = String(body.name || "").trim();
  const siteUrl = normalizeUrl(body.url);
  const note = String(body.note || "").trim() || null;

  if (!name) return json({ ok: false, error: "name is required" }, 400, headers);
  if (!siteUrl) return json({ ok: false, error: "url is required" }, 400, headers);
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return json({ ok: false, error: "url must be http or https" }, 400, headers);
    }
  } catch {
    return json({ ok: false, error: "url is malformed" }, 400, headers);
  }

  const now = Date.now();
  const insertRes = await env.DB.prepare(
    `INSERT INTO sites (name, url, note, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       name = excluded.name,
       note = excluded.note,
       is_active = 1,
       updated_at = excluded.updated_at`
  )
    .bind(name, siteUrl, note, now, now)
    .run();

  return json({ ok: true, id: insertRes?.meta?.last_row_id ?? null }, 200, headers);
}

async function handleSitesDelete(req, env, headers) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const targetUrl = normalizeUrl(url.searchParams.get("url"));
  const hard = url.searchParams.get("hard") === "1";

  if (!id && !targetUrl) {
    return json({ ok: false, error: "either id or url is required" }, 400, headers);
  }

  const where = id ? "id = ?" : "url = ?";
  const param = id || targetUrl;

  if (hard) {
    await env.DB.prepare(`DELETE FROM sites WHERE ${where}`).bind(param).run();
  } else {
    await env.DB.prepare(`UPDATE sites SET is_active = 0, updated_at = ? WHERE ${where}`)
      .bind(Date.now(), param)
      .run();
  }
  return json({ ok: true }, 200, headers);
}

// ===== Operator management =====
async function handleOperatorsList(req, env, headers) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("all") === "1";
  const where = includeInactive ? "" : "WHERE is_active = 1";

  const result = await env.DB.prepare(
    `SELECT
       o.id, o.operator_code, o.name, o.phone, o.note, o.is_active, o.created_at,
       (SELECT MAX(received_at) FROM exposure_events WHERE uid = o.operator_code) AS last_seen,
       (SELECT COUNT(DISTINCT sid) FROM exposure_events WHERE uid = o.operator_code) AS total_sessions,
       (SELECT SUM(CASE WHEN event_type = 'heartbeat' THEN 1 ELSE 0 END) FROM exposure_events WHERE uid = o.operator_code) AS total_heartbeats
     FROM operators o
     ${where}
     ORDER BY o.created_at DESC, o.id DESC`
  ).all();

  return json(
    {
      ok: true,
      operators: (result.results || []).map((r) => ({
        id: Number(r.id),
        operator_code: r.operator_code,
        name: r.name || "",
        phone: r.phone || "",
        note: r.note || "",
        is_active: Number(r.is_active) === 1,
        created_at: Number(r.created_at),
        last_seen: r.last_seen ? Number(r.last_seen) : null,
        last_seen_iso: toIsoOrNull(r.last_seen),
        total_sessions: Number(r.total_sessions || 0),
        total_dwell_seconds: Number(r.total_heartbeats || 0) * HEARTBEAT_INTERVAL_SEC,
      })),
    },
    200,
    headers
  );
}

async function handleOperatorsAdd(req, env, headers) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400, headers); }

  const code = String(body.operator_code || "").trim();
  const name = String(body.name || "").trim() || null;
  const phone = String(body.phone || "").trim() || null;
  const note = String(body.note || "").trim() || null;

  if (!code) return json({ ok: false, error: "operator_code is required" }, 400, headers);
  if (!/^[a-zA-Z0-9_\-]+$/.test(code)) {
    return json({ ok: false, error: "operator_code can only contain letters, digits, _ and -" }, 400, headers);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO operators (operator_code, name, phone, note, is_active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(operator_code) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       note = excluded.note,
       is_active = 1`
  )
    .bind(code, name, phone, note, now)
    .run();

  return json({ ok: true, operator_code: code }, 200, headers);
}

async function handleOperatorsDelete(req, env, headers) {
  const url = new URL(req.url);
  const code = url.searchParams.get("operator_code");
  const hard = url.searchParams.get("hard") === "1";

  if (!code) return json({ ok: false, error: "operator_code is required" }, 400, headers);

  if (hard) {
    await env.DB.prepare(`DELETE FROM operators WHERE operator_code = ?`).bind(code).run();
  } else {
    await env.DB.prepare(`UPDATE operators SET is_active = 0 WHERE operator_code = ?`).bind(code).run();
  }
  return json({ ok: true }, 200, headers);
}

// =============================================================
// Auth: PBKDF2 password hashing + HMAC-SHA256 signed tokens
// =============================================================
//
// Design notes:
// - PBKDF2 with 100k iterations of SHA-256 (OWASP's 2023 floor for SHA-256).
// - Token = base64url(header).base64url(payload).base64url(hmac).
//   Standard JWT shape; we self-issue, never accept third-party tokens.
// - Token TTL: 7 days. localStorage on client; idempotent re-login refreshes.
// - Constant-time compare on hash + signature to mitigate timing attacks.
// - Login endpoint runs a dummy hash on miss to keep timing flat regardless
//   of whether the username exists. Always returns the same generic error.
// - AUTH_SECRET MUST be set as a wrangler secret. We refuse to issue/verify
//   tokens if it's missing — fail closed, never silently accept.

const TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const PBKDF2_ITERATIONS = 100000;

function b64urlEncodeBytes(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeStr(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeStr(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

async function hashPasswordPbkdf2(password, salt) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMat,
    256
  );
  return b64urlEncodeBytes(new Uint8Array(bits));
}

function generateSalt() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return b64urlEncodeBytes(buf);
}

async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return b64urlEncodeBytes(new Uint8Array(sig));
}

async function signAuthToken(payload, secret) {
  const header = b64urlEncodeStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncodeStr(JSON.stringify(payload));
  const sig = await hmacSign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

async function verifyAuthToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = await hmacSign(`${header}.${body}`, secret);
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(b64urlDecodeStr(body));
    if (typeof payload !== "object" || !payload) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function getAuthedUser(req, env) {
  if (!env.AUTH_SECRET) return null;
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  return await verifyAuthToken(token, env.AUTH_SECRET);
}

function unauthorized(headers, msg = "unauthorized") {
  return json({ ok: false, error: msg }, 401, headers);
}
function forbidden(headers) {
  return json({ ok: false, error: "forbidden" }, 403, headers);
}

// ===== Auth endpoints =====
async function handleLogin(req, env, headers) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid request" }, 400, headers); }
  const ident = String(body.username || body.email || "").trim();
  const password = String(body.password || "");
  if (!ident || !password) {
    // Even on early reject, do some work to keep timing somewhat consistent.
    await hashPasswordPbkdf2(password || "x", "dummysalt");
    return json({ ok: false, error: "invalid credentials" }, 401, headers);
  }
  if (!env.AUTH_SECRET) {
    return json({ ok: false, error: "server auth not configured" }, 500, headers);
  }

  const row = await env.DB.prepare(
    `SELECT id, username, email, role, password_hash, salt, is_active
     FROM users
     WHERE (username = ? OR email = ?)
     LIMIT 1`
  ).bind(ident, ident).first();

  if (!row || Number(row.is_active) !== 1) {
    // Dummy work to flatten timing between user-not-found and bad-password.
    await hashPasswordPbkdf2(password, "dummysalt");
    return json({ ok: false, error: "invalid credentials" }, 401, headers);
  }

  const computed = await hashPasswordPbkdf2(password, row.salt);
  if (!constantTimeEqual(computed, row.password_hash)) {
    return json({ ok: false, error: "invalid credentials" }, 401, headers);
  }

  const now = Date.now();
  const exp = Math.floor(now / 1000) + TOKEN_TTL_SECONDS;
  const token = await signAuthToken(
    { sub: row.id, u: row.username, r: row.role, exp },
    env.AUTH_SECRET
  );

  await env.DB.prepare(`UPDATE users SET last_login = ? WHERE id = ?`).bind(now, row.id).run();

  return json(
    {
      ok: true,
      token,
      expires_at: exp * 1000,
      user: { id: row.id, username: row.username, email: row.email || null, role: row.role },
    },
    200,
    headers
  );
}

async function handleAuthMe(req, env, headers, user) {
  // Refresh user info from DB so role/active changes propagate without re-login
  const row = await env.DB.prepare(
    `SELECT id, username, email, role, is_active, last_login, created_at
     FROM users WHERE id = ?`
  ).bind(user.sub).first();
  if (!row || Number(row.is_active) !== 1) return unauthorized(headers, "session invalid");
  return json(
    {
      ok: true,
      user: {
        id: Number(row.id),
        username: row.username,
        email: row.email || null,
        role: row.role,
        last_login: row.last_login ? Number(row.last_login) : null,
        created_at: Number(row.created_at),
      },
    },
    200,
    headers
  );
}

async function handleChangeOwnPassword(req, env, headers, user) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid request" }, 400, headers); }
  const current = String(body.current_password || "");
  const next = String(body.new_password || "");
  if (next.length < 8) return json({ ok: false, error: "新密码至少 8 位" }, 400, headers);

  const row = await env.DB.prepare(
    `SELECT id, password_hash, salt FROM users WHERE id = ? AND is_active = 1`
  ).bind(user.sub).first();
  if (!row) return unauthorized(headers, "session invalid");

  const computed = await hashPasswordPbkdf2(current, row.salt);
  if (!constantTimeEqual(computed, row.password_hash)) {
    return json({ ok: false, error: "当前密码错误" }, 401, headers);
  }

  const newSalt = generateSalt();
  const newHash = await hashPasswordPbkdf2(next, newSalt);
  await env.DB.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`)
    .bind(newHash, newSalt, row.id).run();
  return json({ ok: true }, 200, headers);
}

// ===== User management (super_admin only) =====
async function handleListUsers(req, env, headers) {
  const result = await env.DB.prepare(
    `SELECT id, username, email, role, is_active, last_login, created_at
     FROM users ORDER BY created_at DESC, id DESC`
  ).all();
  return json(
    {
      ok: true,
      users: (result.results || []).map((r) => ({
        id: Number(r.id),
        username: r.username,
        email: r.email || null,
        role: r.role,
        is_active: Number(r.is_active) === 1,
        last_login: r.last_login ? Number(r.last_login) : null,
        last_login_iso: toIsoOrNull(r.last_login),
        created_at: Number(r.created_at),
      })),
    },
    200,
    headers
  );
}

async function handleCreateUser(req, env, headers) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid request" }, 400, headers); }
  const username = String(body.username || "").trim();
  const email = String(body.email || "").trim() || null;
  const password = String(body.password || "");
  const role = String(body.role || "admin").trim();

  if (!/^[a-zA-Z0-9._@\-]{3,64}$/.test(username)) {
    return json({ ok: false, error: "用户名 3-64 位，仅字母数字 . _ - @" }, 400, headers);
  }
  if (password.length < 8) return json({ ok: false, error: "密码至少 8 位" }, 400, headers);
  if (!["super_admin", "admin", "readonly"].includes(role)) {
    return json({ ok: false, error: "role 必须是 super_admin / admin / readonly" }, 400, headers);
  }

  const salt = generateSalt();
  const hash = await hashPasswordPbkdf2(password, salt);
  const now = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO users (username, email, password_hash, salt, role, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).bind(username, email, hash, salt, role, now).run();
  } catch (e) {
    return json({ ok: false, error: "用户名已存在" }, 409, headers);
  }
  return json({ ok: true, username }, 200, headers);
}

async function handleDeleteUser(req, env, headers, currentUser) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id") || 0);
  if (!id) return json({ ok: false, error: "id 必填" }, 400, headers);
  if (id === currentUser.sub) return json({ ok: false, error: "不能停用自己" }, 400, headers);

  await env.DB.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).bind(id).run();
  return json({ ok: true }, 200, headers);
}

// One-shot super-admin bootstrap. Only callable when users table is empty.
// After the first super_admin exists this endpoint returns 403 forever.
// Lets the operator set their own password in the browser (HTTPS body) so
// the plaintext never appears in any shell/log.
async function handleAuthBootstrap(req, env, headers) {
  const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_active = 1`).first();
  if (Number(existing?.n || 0) > 0) {
    return json({ ok: false, error: "bootstrap closed: super_admin already exists" }, 403, headers);
  }
  if (!env.AUTH_SECRET) {
    return json({ ok: false, error: "server auth not configured" }, 500, headers);
  }
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid request" }, 400, headers); }
  const username = String(body.username || "").trim();
  const email = String(body.email || "").trim() || null;
  const password = String(body.password || "");

  if (!/^[a-zA-Z0-9._@\-]{3,64}$/.test(username)) {
    return json({ ok: false, error: "用户名 3-64 位，仅字母数字 . _ - @" }, 400, headers);
  }
  if (password.length < 8) return json({ ok: false, error: "密码至少 8 位" }, 400, headers);

  const salt = generateSalt();
  const hash = await hashPasswordPbkdf2(password, salt);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (username, email, password_hash, salt, role, is_active, created_at)
     VALUES (?, ?, ?, ?, 'super_admin', 1, ?)`
  ).bind(username, email, hash, salt, now).run();

  return json({ ok: true, username, role: "super_admin" }, 200, headers);
}

async function handleAuthBootstrapStatus(req, env, headers) {
  const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_active = 1`).first();
  return json({ ok: true, needs_bootstrap: Number(existing?.n || 0) === 0 }, 200, headers);
}

async function handleResetUserPassword(req, env, headers) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid request" }, 400, headers); }
  const id = Number(body.id || 0);
  const newPwd = String(body.new_password || "");
  if (!id) return json({ ok: false, error: "id 必填" }, 400, headers);
  if (newPwd.length < 8) return json({ ok: false, error: "密码至少 8 位" }, 400, headers);

  const salt = generateSalt();
  const hash = await hashPasswordPbkdf2(newPwd, salt);
  await env.DB.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`)
    .bind(hash, salt, id).run();
  return json({ ok: true }, 200, headers);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "*";
    const headers = corsHeaders(origin);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(req.url);
    const user = await getAuthedUser(req, env);
    const requireAuth = () => user ? null : unauthorized(headers);
    const requireSuper = () => {
      if (!user) return unauthorized(headers);
      if (user.r !== "super_admin") return forbidden(headers);
      return null;
    };

    try {
      // ---- Public: health, ingestion, sites read for scheduler ----
      if (url.pathname === "/health") return json({ ok: true, now: Date.now() }, 200, headers);
      if (url.pathname === "/api/exposure" && req.method === "POST") return await handleExposure(req, env, headers);
      if (url.pathname === "/api/config/urls" && req.method === "POST") return await handleConfigUrls(req, env, headers);
      if (url.pathname === "/api/sites" && req.method === "GET") return await handleSitesList(req, env, headers);

      // ---- Auth ----
      if (url.pathname === "/api/auth/bootstrap" && req.method === "GET") return await handleAuthBootstrapStatus(req, env, headers);
      if (url.pathname === "/api/auth/bootstrap" && req.method === "POST") return await handleAuthBootstrap(req, env, headers);
      if (url.pathname === "/api/auth/login" && req.method === "POST") return await handleLogin(req, env, headers);
      if (url.pathname === "/api/auth/me" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleAuthMe(req, env, headers, user);
      }
      if (url.pathname === "/api/auth/change-password" && req.method === "POST") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleChangeOwnPassword(req, env, headers, user);
      }

      // ---- Reports (auth required) ----
      if (url.pathname === "/api/report" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleReport(req, env, headers);
      }
      if (url.pathname === "/api/report.csv" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleCsv(req, env, headers);
      }
      if (url.pathname === "/api/operator-report" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleOperatorReport(req, env, headers);
      }
      if (url.pathname === "/api/site-report" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleSiteReport(req, env, headers);
      }
      if (url.pathname === "/api/operator-heatmap" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleOperatorHeatmap(req, env, headers);
      }
      if (url.pathname === "/api/session-events" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleSessionEvents(req, env, headers);
      }

      // ---- Sites write (auth) ----
      if (url.pathname === "/api/sites" && req.method === "POST") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleSitesAdd(req, env, headers);
      }
      if (url.pathname === "/api/sites" && req.method === "DELETE") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleSitesDelete(req, env, headers);
      }

      // ---- Operators (auth) ----
      if (url.pathname === "/api/operators" && req.method === "GET") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleOperatorsList(req, env, headers);
      }
      if (url.pathname === "/api/operators" && req.method === "POST") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleOperatorsAdd(req, env, headers);
      }
      if (url.pathname === "/api/operators" && req.method === "DELETE") {
        const denied = requireAuth(); if (denied) return denied;
        return await handleOperatorsDelete(req, env, headers);
      }

      // ---- User management (super_admin only) ----
      if (url.pathname === "/api/admin/users" && req.method === "GET") {
        const denied = requireSuper(); if (denied) return denied;
        return await handleListUsers(req, env, headers);
      }
      if (url.pathname === "/api/admin/users" && req.method === "POST") {
        const denied = requireSuper(); if (denied) return denied;
        return await handleCreateUser(req, env, headers);
      }
      if (url.pathname === "/api/admin/users" && req.method === "DELETE") {
        const denied = requireSuper(); if (denied) return denied;
        return await handleDeleteUser(req, env, headers, user);
      }
      if (url.pathname === "/api/admin/users/reset-password" && req.method === "POST") {
        const denied = requireSuper(); if (denied) return denied;
        return await handleResetUserPassword(req, env, headers);
      }

      return json({ ok: false, error: "Not Found" }, 404, headers);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : "Internal Error" }, 500, headers);
    }
  },
};
