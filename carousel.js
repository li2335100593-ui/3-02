/**
 * Carousel SDK v3.0 (standalone: works with or without URL hash)
 * 
 * 两种使用方式：
 * 1. 通过 scheduler.html 跳转：状态通过 URL hash 传递
 * 2. 直接注入目标网站：配置内置在脚本中，不依赖 hash
 */
;(function () {
  'use strict';

  var ANALYTICS_URL = 'https://exposure-analytics.li2335100593.workers.dev/api/exposure';
  var HEARTBEAT_INTERVAL_SEC = 30;
  var SDK_VERSION = '3.1.2-session-timer';

  // ===== 内置配置（直接注入模式用）=====
  // 如果 URL hash 里没有配置，就使用这里的默认值
  var BUILTIN_CONFIG = {
    urls: [
      'https://livingroom-design.ddmmoney.com/',
      'https://old-house-renovation.chworld.com.tw/',
      'https://incar.tw/'
    ],
    interval: 300,  // 5分钟
    cycle: 3600     // 60分钟
  };

  // Storage keys
  var LS_VID = '__carousel_vid';
  var LS_CYCLE = '__carousel_cycle_v4';
  var LS_STATE = '__carousel_state_v4';
  var LS_QUEUE = '__carousel_exposure_queue_v1';
  var CK_CYCLE = '__carousel_cycle_v4';
  // 24h offline buffer: 30s heartbeats => 2880 events/day, plus page_enter/leave.
  var MAX_QUEUE_SIZE = 5000;
  var lastFlushOk = null;

  function now() { return Date.now(); }

  function createSid() {
    return 'sid_' + now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // ===== Cookie helpers =====
  function setCookie(name, value, seconds) {
    try {
      var expires = '';
      if (seconds) {
        var d = new Date(now() + seconds * 1000);
        expires = '; expires=' + d.toUTCString();
      }
      document.cookie = name + '=' + encodeURIComponent(value) + expires + '; path=/; SameSite=Lax';
    } catch (e) {}
  }

  function getCookie(name) {
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    } catch (e) { return null; }
  }

  // ===== VID =====
  function getVid() {
    try {
      // Priority 1: operator uid from state (set by scheduler ?u=xxx)
      if (state && state.uid) {
        return state.uid;
      }
      // Priority 2: legacy localStorage vid
      var vid = localStorage.getItem(LS_VID);
      if (!vid) {
        vid = 'vid_' + now() + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(LS_VID, vid);
      }
      return vid;
    } catch (e) {
      return 'vid_' + now() + '_' + Math.random().toString(36).slice(2, 10);
    }
  }

  // ===== Device fingerprint (sent once per page_enter) =====
  function deviceFingerprint() {
    var fp = {};
    try { fp.screen_w = (window.screen && window.screen.width) || null; } catch (e) {}
    try { fp.screen_h = (window.screen && window.screen.height) || null; } catch (e) {}
    try { fp.tz_offset = new Date().getTimezoneOffset(); } catch (e) {}
    return fp;
  }

  // ===== Analytics =====
  function readQueue() {
    try {
      var raw = localStorage.getItem(LS_QUEUE);
      var q = raw ? JSON.parse(raw) : [];
      return Array.isArray(q) ? q : [];
    } catch (e) { return []; }
  }

  function writeQueue(q) {
    try {
      if (!q || q.length === 0) {
        localStorage.removeItem(LS_QUEUE);
        return;
      }
      if (q.length > MAX_QUEUE_SIZE) q = q.slice(q.length - MAX_QUEUE_SIZE);
      localStorage.setItem(LS_QUEUE, JSON.stringify(q));
    } catch (e) {}
  }

  function enqueuePayload(payload) {
    var q = readQueue();
    q.push(payload);
    writeQueue(q);
  }

  function queueLength() {
    return readQueue().length;
  }

  function deliverPayload(payload, preferBeacon) {
    var body = JSON.stringify(payload);
    if (preferBeacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(ANALYTICS_URL, new Blob([body], { type: 'application/json' }))) {
          return Promise.resolve(true);
        }
      } catch (e) {}
    }
    return fetch(ANALYTICS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      keepalive: true
    }).then(function (res) {
      return !!(res && res.ok);
    }).catch(function () {
      return false;
    });
  }

  var flushingQueue = false;
  function flushQueueBeaconSync() {
    if (!navigator.sendBeacon) return false;
    var q = readQueue();
    if (!q.length) return true;

    var sent = 0;
    for (var i = 0; i < q.length; i++) {
      try {
        var body = JSON.stringify(q[i]);
        if (!navigator.sendBeacon(ANALYTICS_URL, new Blob([body], { type: 'application/json' }))) break;
        sent += 1;
      } catch (e) {
        break;
      }
    }
    if (sent > 0) writeQueue(q.slice(sent));
    return sent === q.length;
  }

  function flushQueue(preferBeacon) {
    if (flushingQueue) return Promise.resolve(false);
    var q = readQueue();
    if (!q.length) return Promise.resolve(true);

    flushingQueue = true;
    var sent = 0;
    var chain = Promise.resolve(true);
    q.forEach(function (payload) {
      chain = chain.then(function (okSoFar) {
        if (!okSoFar) return false;
        return deliverPayload(payload, preferBeacon).then(function (ok) {
          if (ok) sent += 1;
          return ok;
        });
      });
    });

    return chain.then(function () {
      if (sent > 0) writeQueue(readQueue().slice(sent));
      flushingQueue = false;
      if (readQueue().length) flushQueue(false);
      lastFlushOk = sent === q.length;
      return sent === q.length;
    }).catch(function () {
      if (sent > 0) writeQueue(readQueue().slice(sent));
      flushingQueue = false;
      lastFlushOk = false;
      return false;
    });
  }

  function sendExposure(eventType, extra) {
    try {
      if (!state) return;
      var payload = {
        event_type: eventType,
        sid: state.sid || null,
        vid: getVid(),
        uid: state.uid || null,
        url: window.location.origin + window.location.pathname,
        page_index: state.ci,
        client_version: SDK_VERSION,
        queue_length: queueLength(),
        visibility_state: document.visibilityState || 'visible',
        client_ts: now()
      };
      if (typeof pageSlotN !== 'undefined') payload.navigation_slot = pageSlotN;
      if (lastFlushOk !== null) payload.last_flush_ok = lastFlushOk;
      if (eventType === 'page_enter') {
        var fp = deviceFingerprint();
        for (var fk in fp) if (fp[fk] != null) payload[fk] = fp[fk];
      }
      if (extra && typeof extra === 'object') {
        for (var k in extra) payload[k] = extra[k];
      }
      if (eventType === 'page_leave' && navigator.sendBeacon) {
        try {
          var leaveBody = JSON.stringify(payload);
          if (navigator.sendBeacon(ANALYTICS_URL, new Blob([leaveBody], { type: 'application/json' }))) {
            if (!flushingQueue) flushQueueBeaconSync();
            return;
          }
        } catch (e) {}
      }
      enqueuePayload(payload);
      flushQueue(eventType === 'page_leave');
    } catch (e) {}
  }

  // ===== Base64 =====
  function decodeB64(b64) {
    try {
      var bin = atob(b64);
      var bytes = [];
      for (var i = 0; i < bin.length; i++) {
        bytes.push('%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2));
      }
      return decodeURIComponent(bytes.join(''));
    } catch (e) { return null; }
  }

  function encodeB64(str) {
    try {
      return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(m, p) {
        return String.fromCharCode('0x' + p);
      }));
    } catch (e) { return null; }
  }

  // ===== Find current page index in URL list =====
  function findCurrentIndex(urls) {
    var current = window.location.origin + window.location.pathname;
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      // Remove trailing slash for comparison
      var normalizedUrl = url.replace(/\/$/, '');
      var normalizedCurrent = current.replace(/\/$/, '');
      if (normalizedCurrent.indexOf(normalizedUrl) === 0 || normalizedUrl.indexOf(normalizedCurrent) === 0) {
        return i;
      }
    }
    return 0; // Default to first URL
  }

  // ===== Get cycle start =====
  // Priority: hash _ct  >  localStorage  >  cookie  >  new now()
  // Hash takes top priority so internal-link clicks (which carry ct via mergeIntoUrl)
  // don't reset the cycle even if cross-domain storage isolation wipes localStorage.
  function getCycleStart(cy, hashCt) {
    if (hashCt && !isNaN(hashCt)) {
      var hashAge = now() - hashCt;
      if (hashAge >= 0 && hashAge < cy * 1000) {
        try { localStorage.setItem(LS_CYCLE, String(hashCt)); } catch (e) {}
        setCookie(CK_CYCLE, String(hashCt), cy);
        return hashCt;
      }
    }
    var ct = null;
    try {
      var s = localStorage.getItem(LS_CYCLE);
      if (s) ct = parseInt(s, 10);
    } catch (e) {}
    if (!ct || isNaN(ct)) {
      var c = getCookie(CK_CYCLE);
      if (c) ct = parseInt(c, 10);
    }
    if (ct && !isNaN(ct)) {
      var age = now() - ct;
      if (age >= 0 && age < cy * 1000) {
        return ct;
      }
    }
    var t = now();
    try { localStorage.setItem(LS_CYCLE, String(t)); } catch (e) {}
    setCookie(CK_CYCLE, String(t), cy);
    return t;
  }

  // ===== Save state =====
  function save(st) {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({ state: st, saved_at: now() }));
    } catch (e) {}
  }

  // ===== Read state from hash (scheduler mode) =====
  function fromHash() {
    var raw = window.location.hash;
    if (!raw || raw.length < 2) return null;
    var p = new URLSearchParams(raw.substring(1));
    var cu = p.get('_cu');
    if (!cu) return null;
    var decoded = decodeB64(cu);
    if (!decoded) return null;
    try {
      var urls = JSON.parse(decoded);
      if (!Array.isArray(urls) || urls.length === 0) return null;
      var ci = parseInt(p.get('_ci'), 10);
      if (isNaN(ci) || ci < 0 || ci >= urls.length) ci = 0;
      var iv = parseInt(p.get('_iv'), 10) || 300;
      var cy = parseInt(p.get('_cy'), 10) || 3600;
      var ctRaw = parseInt(p.get('_ct'), 10);
      var ct = !isNaN(ctRaw) && ctRaw > 0 ? ctRaw : null;
      return {
        ci: ci,
        ct: ct,
        iv: iv,
        cy: cy,
        cu: cu,
        st: parseInt(p.get('_st'), 10) || null,
        sid: p.get('_sid') || createSid(),
        uid: p.get('_u') || null,
        urls: urls
      };
    } catch (e) { return null; }
  }

  // ===== Read state from localStorage =====
  function fromLS() {
    try {
      var s = localStorage.getItem(LS_STATE);
      if (!s) return null;
      var p = JSON.parse(s);
      if (!p || !p.state) return null;
      var st = p.state;
      // Validate
      if (!st.cu || !st.urls || !Array.isArray(st.urls)) return null;
      return st;
    } catch (e) { return null; }
  }

  // ===== Build state from builtin config =====
  function fromBuiltin() {
    var cu = encodeB64(JSON.stringify(BUILTIN_CONFIG.urls));
    if (!cu) return null;
    return {
      ci: findCurrentIndex(BUILTIN_CONFIG.urls),
      iv: BUILTIN_CONFIG.interval,
      cy: BUILTIN_CONFIG.cycle,
      cu: cu,
      sid: createSid(),
      uid: null,
      urls: BUILTIN_CONFIG.urls
    };
  }

  // ===== Parse state: try hash -> localStorage -> builtin =====
  var hashState = fromHash();
  var lsState = fromLS();
  var builtinState = fromBuiltin();

  var base = hashState || lsState || builtinState;

  if (!base) {
    console.log('[carousel] no state available, exiting');
    return;
  }

  // If we have a UID from hash, use it
  if (hashState && hashState.uid) {
    base.uid = hashState.uid;
  }

  var cycleStart = getCycleStart(base.cy, base.ct);

  var state = {
    ci: base.ci,
    ct: cycleStart,
    iv: base.iv,
    cy: base.cy,
    cu: base.cu,
    st: base.st || null,
    sid: base.sid,
    uid: base.uid,
    urls: base.urls
  };

  console.log('[carousel] loaded ci=' + state.ci + ' ctAge=' + (now() - state.ct) + 'ms mode=' + (hashState ? 'hash' : (lsState ? 'storage' : 'builtin')));

  // ===== Merge state into link hash =====
  function mergeIntoUrl(targetUrl, st) {
    var p = new URLSearchParams(targetUrl.hash ? targetUrl.hash.substring(1) : '');
    p.set('_ci', String(st.ci));
    p.set('_ct', String(st.ct));
    p.set('_iv', String(st.iv));
    p.set('_cy', String(st.cy));
    p.set('_cu', st.cu);
    if (st.st) p.set('_st', String(st.st));
    p.set('_sid', st.sid);
    if (st.uid) p.set('_u', st.uid);
    targetUrl.hash = p.toString();
    return targetUrl;
  }

  // ===== Sync hash to address bar =====
  function syncHash(st) {
    try {
      var cur = new URL(window.location.href);
      var before = cur.hash;
      mergeIntoUrl(cur, st);
      if (cur.hash !== before && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', cur.toString());
      }
    } catch (e) {}
  }

  // ===== Intercept clicks on internal links =====
  function attachLinkInterceptor() {
    document.addEventListener('click', function (e) {
      try {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a || !a.href) return;
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (a.hasAttribute('download')) return;
        if (a.target && a.target.toLowerCase() !== '_self') return;

        var u = new URL(a.href, window.location.href);
        if (u.origin !== window.location.origin) return;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;

        mergeIntoUrl(u, state);
        a.href = u.toString();
        save(state);
      } catch (err) {}
    }, true);
  }

  // ===== Timer (slot-based scheduling) =====
  // GUARANTEE: within every cycle of `cy` seconds, exactly cy/iv navigations
  // occur — page load latency is absorbed inside the slot, never extends it.
  //
  // intervalSec    — per-slot length (e.g., 300s)
  // pageStartTime  — when THIS page boot happened (used for per-page dwell only)
  // state.ct       — cycle anchor (preserved across pages via hash); slots are
  //                   measured as absolute windows from ct, NOT from page boot
  // pageSlotN      — which slot (relative to ct) this page belongs to
  // pageSlotEndMs  — absolute timestamp when this slot ends (= when to navigate)
  //
  // Key insight: navigate() schedules the NEXT slot from the wall clock, so a
  // slow-loading page that boots 60s late only gets 240s of dwell — the next
  // navigation still fires exactly at slot end. 12 slots per hour, always.
  var intervalSec = state.iv;
  var pageStartTime = now();
  var tickTimer = null;
  if (!state.st || isNaN(state.st) || state.st > pageStartTime + 60 * 1000) {
    state.st = pageStartTime;
  }
  // Credit work only after the operator has actually stayed for a full
  // heartbeat interval. Sending at pageStartTime would make each rotation
  // count an extra 30 seconds.
  var nextHeartbeatAt = pageStartTime + HEARTBEAT_INTERVAL_SEC * 1000;

  // Compute this page's slot ONCE at boot and lock it in.
  var pageSlotN = Math.floor((pageStartTime - state.ct) / (intervalSec * 1000));
  if (pageSlotN < 0) pageSlotN = 0;
  var pageSlotEndMs = state.ct + (pageSlotN + 1) * intervalSec * 1000;

  function elapsed() {
    return Math.floor((now() - pageStartTime) / 1000);
  }

  function sessionElapsed() {
    return Math.max(0, Math.floor((now() - state.st) / 1000));
  }

  function slotRemainingMs() {
    var r = pageSlotEndMs - now();
    return r < 0 ? 0 : r;
  }

  function activeDwellMs(at) {
    return Math.max(0, at - pageStartTime);
  }

  function sendDueHeartbeats() {
    var sent = 0;
    var maxCatchup = 12;
    while (now() >= nextHeartbeatAt && sent < maxCatchup) {
      sendExposure('heartbeat', { dwell_ms: activeDwellMs(nextHeartbeatAt) });
      nextHeartbeatAt += HEARTBEAT_INTERVAL_SEC * 1000;
      sent += 1;
    }

    // Avoid flooding after a long browser suspension; resume from the current wall clock.
    if (sent >= maxCatchup && now() >= nextHeartbeatAt) {
      nextHeartbeatAt = now() + HEARTBEAT_INTERVAL_SEC * 1000;
    }
  }

  function tick() {
    updateUI();
    flushQueue(false);
    sendDueHeartbeats();
    if (now() >= pageSlotEndMs) {
      navigate();
    }
  }

  // ===== Wake lock =====
  var wakeLockSentinel = null;
  var silentVideo = null;

  function requestWakeLock() {
    if ('wakeLock' in navigator && navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen')
        .then(function (s) {
          wakeLockSentinel = s;
          s.addEventListener('release', function () { wakeLockSentinel = null; });
        })
        .catch(function () { ensureSilentVideo(); });
    } else {
      ensureSilentVideo();
    }
  }

  function ensureSilentVideo() {
    try {
      if (silentVideo) return;
      var v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
      v.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAAhmcmVlAAABQG1kYXQhEAUgpAABthYQAAAD6GxhdmM1OC4xMzQ=';
      document.body.appendChild(v);
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      silentVideo = v;
    } catch (e) {}
  }

  function onVisibilityChange() {
    // A background tab/window is still an active playback session for this
    // product. Keep heartbeats going whenever the browser gives us timer time;
    // only pagehide/tab close should end a session.
    if (document.visibilityState !== 'hidden' && !wakeLockSentinel) requestWakeLock();
    flushQueue(false);
    tick();
  }

  // Force-close detection: pagehide is the most reliable cross-browser hook
  // (fires for tab close, app switch, navigation, bfcache). Send leave once
  // via beacon so we always have a session-end timestamp even when the
  // operator hard-closes the browser/app.
  var pagehideFired = false;
  function onPageHide() {
    if (pagehideFired || navigated) return;
    pagehideFired = true;
    sendExposure('page_leave', { dwell_ms: activeDwellMs(now()), reason: 'pagehide' });
  }

  // ===== Navigation =====
  var navigated = false;

  function urlWithoutHash(u) {
    try {
      return u.origin + u.pathname + u.search;
    } catch (e) {
      return '';
    }
  }

  function isSameDocumentTarget(targetUrl) {
    try {
      return urlWithoutHash(new URL(window.location.href)) === urlWithoutHash(targetUrl);
    } catch (e) {
      return false;
    }
  }

  function continueCurrentDocument(nextSlotN, nextIndex) {
    state.ci = nextIndex;
    pageSlotN = nextSlotN;
    pageSlotEndMs = state.ct + (pageSlotN + 1) * intervalSec * 1000;
    save(state);
    syncHash(state);
  }

  function navigate() {
    if (navigated) return;

    var urls = state.urls;
    var t = now();
    var slotsPerCycle = Math.floor(state.cy / state.iv);
    if (slotsPerCycle < 1) slotsPerCycle = 1;

    // Next slot is anchored to the wall clock (not to ci), so slow page loads
    // never accumulate drift. Take max(clockSlot+1, pageSlotN+1) as a safety
    // floor in case of clock anomalies.
    // At the exact slot boundary, floor(now - ct) already points at the next
    // slot. Adding 1 here skips a slot and can make 2-site rotations land back
    // on the same URL, which stops real rotation and only advances the hash.
    var clockSlot = Math.floor((t - state.ct) / (intervalSec * 1000));
    var nextSlotN = clockSlot;
    if (nextSlotN < pageSlotN + 1) nextSlotN = pageSlotN + 1;

    // Cycle wrap: only reset ct when a full cycle has elapsed, NOT on URL wrap.
    // This is what guarantees `slotsPerCycle` navigations per `cy` seconds.
    if (nextSlotN >= slotsPerCycle) {
      nextSlotN = 0;
      state.ct = t;
      try { localStorage.setItem(LS_CYCLE, String(t)); } catch (e) {}
      setCookie(CK_CYCLE, String(t), state.cy);
    }

    var nextIndex = nextSlotN % urls.length;

    var nextUrl;
    try {
      nextUrl = new URL(urls[nextIndex], window.location.href);
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return;
    } catch (e) { return; }

    if (isSameDocumentTarget(nextUrl)) {
      continueCurrentDocument(nextSlotN, nextIndex);
      return;
    }

    navigated = true;
    sendExposure('page_leave', { dwell_ms: activeDwellMs(now()) });
    if (tickTimer) clearInterval(tickTimer);
    try { if (wakeLockSentinel) wakeLockSentinel.release(); } catch (e) {}
    try { if (silentVideo && silentVideo.parentNode) silentVideo.parentNode.removeChild(silentVideo); } catch (e) {}

    state.ci = nextIndex;
    save(state);
    mergeIntoUrl(nextUrl, state);
    window.location.href = nextUrl.toString();
  }

  // ===== UI =====
  var barEl = null;
  var timerCardEl = null;
  var timerElapsedEl = null;
  var timerSlotEl = null;
  var timerSyncEl = null;
  var timerUidEl = null;
  var timerMiniBarEl = null;
  var timerMiniTrackEl = null;
  var timerStatusRowEl = null;

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatDuration(totalSec) {
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return pad2(m) + ':' + pad2(s);
  }

  function initUI() {
    var container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;z-index:2147483647;pointer-events:none;font-family:"Avenir Next","PingFang SC","Microsoft YaHei",sans-serif;';

    barEl = document.createElement('div');
    barEl.style.cssText = 'height:4px;width:0%;background:linear-gradient(90deg,#16f2b3,#35a3ff,#8b5cf6);box-shadow:0 -6px 22px rgba(53,163,255,.35);transition:width 0.25s linear;';

    timerCardEl = document.createElement('div');
    timerCardEl.setAttribute('aria-live', 'polite');
    timerCardEl.style.cssText = [
      'position:fixed',
      'top:max(14px,env(safe-area-inset-top))',
      'right:max(14px,env(safe-area-inset-right))',
      'z-index:2147483647',
      'width:218px',
      'box-sizing:border-box',
      'padding:12px 14px 11px',
      'border-radius:20px',
      'pointer-events:none',
      'color:#f8fafc',
      'font-family:"Avenir Next","PingFang SC","Microsoft YaHei",sans-serif',
      'background:linear-gradient(145deg,rgba(7,18,35,.94),rgba(18,43,84,.90))',
      'border:1px solid rgba(255,255,255,.20)',
      'box-shadow:0 18px 45px rgba(8,20,42,.38),inset 0 1px 0 rgba(255,255,255,.24)',
      'backdrop-filter:blur(18px) saturate(1.2)',
      '-webkit-backdrop-filter:blur(18px) saturate(1.2)'
    ].join(';') + ';';

    timerStatusRowEl = document.createElement('div');
    timerStatusRowEl.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;';

    var statusLeft = document.createElement('div');
    statusLeft.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0;';

    var dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:999px;background:#16f2b3;box-shadow:0 0 0 5px rgba(22,242,179,.14),0 0 18px rgba(22,242,179,.75);';

    var statusLabel = document.createElement('span');
    statusLabel.textContent = '记录中';
    statusLabel.style.cssText = 'font-size:12px;font-weight:800;letter-spacing:.08em;color:#dffcf4;';

    timerUidEl = document.createElement('div');
    timerUidEl.style.cssText = 'max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:700;color:rgba(226,240,255,.72);';
    timerUidEl.textContent = state.uid || '未设 UID';
    if (state.uid) timerUidEl.title = state.uid;

    statusLeft.appendChild(dot);
    statusLeft.appendChild(statusLabel);
    timerStatusRowEl.appendChild(statusLeft);
    timerStatusRowEl.appendChild(timerUidEl);

    timerElapsedEl = document.createElement('div');
    timerElapsedEl.style.cssText = 'font-size:28px;line-height:1.05;font-weight:900;letter-spacing:.02em;font-variant-numeric:tabular-nums;color:#ffffff;text-shadow:0 6px 24px rgba(0,0,0,.28);';
    timerElapsedEl.textContent = '00:00';

    timerSlotEl = document.createElement('div');
    timerSlotEl.style.cssText = 'margin-top:7px;font-size:12px;line-height:1.35;color:rgba(226,240,255,.82);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

    timerMiniTrackEl = document.createElement('div');
    timerMiniTrackEl.style.cssText = 'height:6px;margin-top:9px;border-radius:999px;background:rgba(226,240,255,.16);overflow:hidden;';
    timerMiniBarEl = document.createElement('div');
    timerMiniBarEl.style.cssText = 'height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#16f2b3,#35a3ff);box-shadow:0 0 18px rgba(53,163,255,.48);transition:width .25s linear;';
    timerMiniTrackEl.appendChild(timerMiniBarEl);

    timerSyncEl = document.createElement('div');
    timerSyncEl.style.cssText = 'margin-top:8px;font-size:11px;line-height:1.25;color:rgba(226,240,255,.66);font-variant-numeric:tabular-nums;';

    timerCardEl.appendChild(timerStatusRowEl);
    timerCardEl.appendChild(timerElapsedEl);
    timerCardEl.appendChild(timerSlotEl);
    timerCardEl.appendChild(timerMiniTrackEl);
    timerCardEl.appendChild(timerSyncEl);

    container.appendChild(barEl);
    document.body.appendChild(container);
    document.body.appendChild(timerCardEl);
    applyTimerLayout();
    try { window.addEventListener('resize', applyTimerLayout); } catch (e) {}
    try { window.addEventListener('orientationchange', applyTimerLayout); } catch (e) {}
  }

  function applyTimerLayout() {
    if (!timerCardEl || !timerElapsedEl || !timerSlotEl || !timerSyncEl || !timerUidEl || !timerMiniBarEl || !timerMiniTrackEl || !timerStatusRowEl) return;
    var vw = 999;
    try { vw = window.innerWidth || document.documentElement.clientWidth || 999; } catch (e) {}
    var compact = vw <= 520;

    timerCardEl.style.width = compact ? '138px' : '218px';
    timerCardEl.style.padding = compact ? '7px 9px 8px' : '12px 14px 11px';
    timerCardEl.style.borderRadius = compact ? '15px' : '20px';
    timerCardEl.style.top = compact ? 'max(8px,env(safe-area-inset-top))' : 'max(14px,env(safe-area-inset-top))';
    timerCardEl.style.right = compact ? 'max(8px,env(safe-area-inset-right))' : 'max(14px,env(safe-area-inset-right))';
    timerCardEl.style.boxShadow = compact
      ? '0 12px 30px rgba(8,20,42,.34),inset 0 1px 0 rgba(255,255,255,.22)'
      : '0 18px 45px rgba(8,20,42,.38),inset 0 1px 0 rgba(255,255,255,.24)';
    timerStatusRowEl.style.marginBottom = compact ? '2px' : '5px';
    timerElapsedEl.style.fontSize = compact ? '20px' : '28px';
    timerElapsedEl.style.lineHeight = compact ? '1' : '1.05';
    timerUidEl.style.display = compact ? 'none' : 'block';
    timerUidEl.style.maxWidth = compact ? '0' : '96px';
    timerUidEl.style.fontSize = compact ? '10px' : '11px';
    timerSlotEl.style.marginTop = compact ? '3px' : '7px';
    timerSlotEl.style.fontSize = compact ? '10px' : '12px';
    timerSyncEl.style.marginTop = compact ? '6px' : '8px';
    timerSyncEl.style.fontSize = compact ? '10px' : '11px';
    timerSyncEl.style.display = compact ? 'none' : 'block';
    timerMiniTrackEl.style.height = compact ? '4px' : '6px';
    timerMiniTrackEl.style.marginTop = compact ? '6px' : '9px';
  }

  function updateUI() {
    if (!barEl || !timerElapsedEl || !timerSlotEl || !timerSyncEl || !timerMiniBarEl) return;
    // Progress bar tracks countdown to slot end, not per-page elapsed —
    // ensures the bar reaches 100% exactly when navigation fires.
    var totalMs = intervalSec * 1000;
    var remMs = slotRemainingMs();
    var pct = ((totalMs - remMs) / totalMs) * 100;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    barEl.style.width = pct + '%';
    timerMiniBarEl.style.width = pct + '%';
    var rem = Math.ceil(remMs / 1000);
    var timeStr = formatDuration(rem);
    var pageLabel = (state.ci + 1) + '/' + state.urls.length;
    var syncIn = Math.max(0, Math.ceil((nextHeartbeatAt - now()) / 1000));
    var qLen = queueLength();
    timerElapsedEl.textContent = formatDuration(sessionElapsed());
    timerSlotEl.textContent = '站点 ' + pageLabel + ' · 本页剩 ' + timeStr;
    timerSyncEl.textContent = (qLen > 0)
      ? ('离线队列 ' + qLen + ' 条 · 网络恢复自动补传')
      : ('报表同步中 · 下次约 ' + syncIn + 's');
  }

  // ===== Boot =====
  function boot() {
    save(state);
    syncHash(state);
    initUI();
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', function () { flushQueue(false); tick(); });
    window.addEventListener('pageshow', function () { flushQueue(false); tick(); });
    window.addEventListener('online', function () { flushQueue(false); });
    window.addEventListener('pagehide', onPageHide);
    attachLinkInterceptor();
    sendExposure('page_enter');
    tickTimer = setInterval(tick, 1000);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
