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
  var CK_CYCLE = '__carousel_cycle_v4';

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
  function getCycleStart(cy) {
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
      return {
        ci: ci,
        iv: iv,
        cy: cy,
        cu: cu,
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

  console.log('[carousel] loaded ci=' + state.ci + ' ctAge=' + (now() - state.ct) + 'ms mode=' + (hashState ? 'hash' : (lsState ? 'storage' : 'builtin')));

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
    var ctAgeSec = Math.floor((now() - state.ct) / 1000);
    textEl.textContent = pageLabel + ' — ' + timeStr + uidLabel + ' | d:' + ctAgeSec + 's';
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
