/**
 * Carousel SDK v2.2 (robust: cycle timing persistence via localStorage + cookie fallback)
 */
;(function () {
  'use strict';

  var ANALYTICS_URL = 'https://exposure-analytics.li2335100593.workers.dev/api/exposure';
  var HEARTBEAT_INTERVAL_SEC = 30;

  // Storage keys
  var LS_VID = '__carousel_vid';
  var LS_CYCLE = '__carousel_cycle_v3';
  var LS_STATE = '__carousel_state_v3';
  var CK_CYCLE = '__carousel_cycle_v3';

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

  // ===== Analytics =====
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
        client_ts: now()
      };
      if (extra && typeof extra === 'object') {
        for (var k in extra) payload[k] = extra[k];
      }
      var body = JSON.stringify(payload);
      if (eventType === 'page_leave' && navigator.sendBeacon) {
        try {
          if (navigator.sendBeacon(ANALYTICS_URL, new Blob([body], { type: 'application/json' }))) return;
        } catch (e) {}
      }
      fetch(ANALYTICS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  // ===== Base64 decode =====
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

  // ===== Normalize state =====
  function normalize(raw) {
    if (!raw) return null;
    var ci = parseInt(raw.ci, 10);
    var iv = parseInt(raw.iv, 10);
    var cy = parseInt(raw.cy, 10);
    var cu = raw.cu;
    var sid = raw.sid || createSid();
    var uid = raw.uid || null;

    if (cu == null) return null;
    if (isNaN(ci) || isNaN(iv) || isNaN(cy)) return null;
    if (iv <= 0 || cy <= 0) return null;

    var decoded = decodeB64(cu);
    if (!decoded) return null;

    var urls;
    try { urls = JSON.parse(decoded); } catch (e) { return null; }
    if (!Array.isArray(urls) || urls.length === 0) return null;
    if (ci < 0 || ci >= urls.length) ci = 0;

    return { ci: ci, iv: iv, cy: cy, cu: cu, sid: sid, uid: uid, urls: urls };
  }

  // ===== Read state from hash =====
  function fromHash() {
    var raw = window.location.hash;
    if (!raw || raw.length < 2) return null;
    var p = new URLSearchParams(raw.substring(1));
    return normalize({
      ci: p.get('_ci'),
      iv: p.get('_iv'),
      cy: p.get('_cy'),
      cu: p.get('_cu'),
      sid: p.get('_sid') || createSid(),
      uid: p.get('_u') || null
    });
  }

  // ===== Read state from localStorage =====
  function fromLS() {
    try {
      var s = localStorage.getItem(LS_STATE);
      if (!s) return null;
      var p = JSON.parse(s);
      return p && p.state ? normalize(p.state) : null;
    } catch (e) { return null; }
  }

  // ===== Get cycle start (global, shared across all pages) =====
  function getCycleStart(cy) {
    var ct = null;
    // Try localStorage first
    try {
      var s = localStorage.getItem(LS_CYCLE);
      if (s) ct = parseInt(s, 10);
    } catch (e) {}
    // Fallback to cookie
    if (!ct || isNaN(ct)) {
      var c = getCookie(CK_CYCLE);
      if (c) ct = parseInt(c, 10);
    }
    // Validate
    if (ct && !isNaN(ct)) {
      var age = now() - ct;
      if (age >= 0 && age < cy * 1000) {
        return ct; // Cycle still running, reuse
      }
    }
    // Start new cycle
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

  // ===== Merge state into link hash =====
  function mergeIntoUrl(targetUrl, st) {
    var p = new URLSearchParams(targetUrl.hash ? targetUrl.hash.substring(1) : '');
    p.set('_ci', String(st.ci));
    p.set('_iv', String(st.iv));
    p.set('_cy', String(st.cy));
    p.set('_cu', st.cu);
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

  // ===== Parse state =====
  var hashState = fromHash();
  var lsState = fromLS();
  var base = hashState || lsState;

  if (!base) {
    console.log('[carousel] no state, exiting');
    return;
  }

  var cycleStart = getCycleStart(base.cy);

  var state = {
    ci: base.ci,
    ct: cycleStart,
    iv: base.iv,
    cy: base.cy,
    cu: base.cu,
    sid: base.sid,
    uid: base.uid,
    urls: base.urls
  };

  console.log('[carousel] loaded ci=' + state.ci + ' ctAge=' + (now() - state.ct) + 'ms');

  // ===== Timer =====
  var intervalSec = state.iv;
  var startTime = state.ct;
  var tickTimer = null;
  var lastHbSec = -1;

  function elapsed() {
    return Math.floor((now() - startTime) / 1000);
  }

  function tick() {
    var e = elapsed();
    updateUI(e);
    if (e >= 0 && e % HEARTBEAT_INTERVAL_SEC === 0 && e !== lastHbSec) {
      lastHbSec = e;
      sendExposure('heartbeat', { dwell_ms: e * 1000 });
    }
    if (e >= intervalSec) {
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
    if (document.visibilityState === 'visible' && !wakeLockSentinel) {
      requestWakeLock();
    }
  }

  // ===== Navigation =====
  var navigated = false;

  function navigate() {
    if (navigated) return;
    navigated = true;

    sendExposure('page_leave', { dwell_ms: now() - startTime });
    if (tickTimer) clearInterval(tickTimer);
    try { if (wakeLockSentinel) wakeLockSentinel.release(); } catch (e) {}
    try { if (silentVideo && silentVideo.parentNode) silentVideo.parentNode.removeChild(silentVideo); } catch (e) {}

    var urls = state.urls;
    var nextIndex = state.ci + 1;
    var t = now();

    if (nextIndex >= urls.length || (t - state.ct) >= state.cy * 1000) {
      nextIndex = 0;
      state.ct = t;
      try { localStorage.setItem(LS_CYCLE, String(t)); } catch (e) {}
      setCookie(CK_CYCLE, String(t), state.cy);
    }

    var nextUrl;
    try {
      nextUrl = new URL(urls[nextIndex], window.location.href);
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return;
    } catch (e) { return; }

    state.ci = nextIndex;
    save(state);
    mergeIntoUrl(nextUrl, state);
    window.location.href = nextUrl.toString();
  }

  // ===== UI =====
  var barEl = null;
  var textEl = null;

  function initUI() {
    var container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;z-index:2147483647;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    barEl = document.createElement('div');
    barEl.style.cssText = 'height:4px;width:0%;background:#35a3ff;transition:width 0.25s linear;';

    textEl = document.createElement('div');
    textEl.style.cssText = 'position:fixed;right:10px;bottom:8px;padding:2px 8px;font-size:12px;color:#fff;background:rgba(0,0,0,0.55);border-radius:10px;';
    textEl.textContent = '...';

    container.appendChild(barEl);
    document.body.appendChild(container);
    document.body.appendChild(textEl);
  }

  function updateUI(elapsedSec) {
    if (!barEl || !textEl) return;
    var pct = Math.min((elapsedSec / intervalSec) * 100, 100);
    barEl.style.width = pct + '%';
    var rem = intervalSec - elapsedSec;
    if (rem < 0) rem = 0;
    var min = Math.floor(rem / 60);
    var sec = rem % 60;
    var timeStr = min + ':' + (sec < 10 ? '0' : '') + sec;
    var pageLabel = (state.ci + 1) + '/' + state.urls.length;
    var uidLabel = state.uid ? ' [' + state.uid + ']' : '';
    // DEBUG: show ctAge in UI to diagnose reset issues
    var ctAgeSec = Math.floor((now() - state.ct) / 1000);
    textEl.textContent = pageLabel + ' — ' + timeStr + uidLabel + ' | debug:' + ctAgeSec + 's';
  }

  // ===== Boot =====
  function boot() {
    save(state);
    syncHash(state);
    initUI();
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
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
