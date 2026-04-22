/**
 * Carousel SDK v2.1 (fixed: persistent cycle timing across navigation)
 * 客户嵌入脚本 — 从 URL hash + localStorage 读取轮播状态，自动定时跳转
 *
 * Hash 格式:
 * #_ci=<index>&_iv=<interval>&_cy=<cycle>&_cu=<base64urls>&_sid=<sessionId>&_u=<userId>
 *
 * 注意: _ct (cycle start time) 不再通过 hash 传递，而是通过 localStorage 全局共享
 */
;(function () {
  'use strict';

  // ===== Analytics Config =====
  var ANALYTICS_URL = 'https://exposure-analytics.li2335100593.workers.dev/api/exposure';
  var HEARTBEAT_INTERVAL_SEC = 30;

  // localStorage keys
  var LS_VID = '__carousel_vid';
  var LS_CYCLE_START = '__carousel_cycle_start_v2';
  var LS_STATE = '__carousel_state_v2';

  function createSessionId() {
    return 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function getVid() {
    try {
      var vid = localStorage.getItem(LS_VID);
      if (!vid) {
        vid = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(LS_VID, vid);
      }
      return vid;
    } catch (e) {
      return 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    }
  }

  // ===== 上报 =====
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
        client_ts: Date.now()
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
      fetch(ANALYTICS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  /* ====================================================================
   * Module 1 — 状态管理
   * ==================================================================== */

  function decodeBase64Unicode(b64) {
    try {
      var binary = atob(b64);
      var bytes = [];
      for (var i = 0; i < binary.length; i++) {
        bytes.push('%' + ('00' + binary.charCodeAt(i).toString(16)).slice(-2));
      }
      return decodeURIComponent(bytes.join(''));
    } catch (e) { return null; }
  }

  function normalizeStateObject(rawState) {
    if (!rawState) return null;
    var ci = parseInt(rawState.ci, 10);
    var iv = parseInt(rawState.iv, 10);
    var cy = parseInt(rawState.cy, 10);
    var cu = rawState.cu;
    var sid = rawState.sid || createSessionId();
    var uid = rawState.uid || null;

    if (cu == null) return null;
    if (isNaN(ci) || isNaN(iv) || isNaN(cy)) return null;
    if (iv <= 0 || cy <= 0) return null;

    var decoded = decodeBase64Unicode(cu);
    if (!decoded) return null;

    var urls;
    try { urls = JSON.parse(decoded); } catch (e) { return null; }
    if (!Array.isArray(urls) || urls.length === 0) return null;
    if (ci < 0 || ci >= urls.length) ci = 0;

    return { ci: ci, iv: iv, cy: cy, cu: cu, sid: sid, uid: uid, urls: urls };
  }

  // 从 hash 读取状态（不含 ct）
  function parseStateFromHash() {
    var raw = window.location.hash;
    if (!raw || raw.length < 2) return null;
    var params = new URLSearchParams(raw.substring(1));
    return normalizeStateObject({
      ci: params.get('_ci'),
      iv: params.get('_iv'),
      cy: params.get('_cy'),
      cu: params.get('_cu'),
      sid: params.get('_sid') || createSessionId(),
      uid: params.get('_u') || null
    });
  }

  // 从 localStorage 读取状态
  function parseStateFromStorage() {
    try {
      var saved = localStorage.getItem(LS_STATE);
      if (!saved) return null;
      var parsed = JSON.parse(saved);
      if (!parsed || !parsed.state) return null;
      return normalizeStateObject(parsed.state);
    } catch (e) { return null; }
  }

  // 获取全局周期开始时间（所有页面共享）
  function getCycleStart(cy) {
    try {
      var saved = localStorage.getItem(LS_CYCLE_START);
      if (saved) {
        var ct = parseInt(saved, 10);
        var age = Date.now() - ct;
        // 如果周期还没结束，继续用旧的
        if (!isNaN(ct) && age >= 0 && age < cy * 1000) {
          return ct;
        }
      }
    } catch (e) {}
    // 周期已结束或没有保存的，创建新的
    var now = Date.now();
    try { localStorage.setItem(LS_CYCLE_START, String(now)); } catch (e) {}
    return now;
  }

  // 保存状态到 localStorage
  function saveState(rawState) {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({ state: rawState, saved_at: Date.now() }));
    } catch (e) {}
  }

  // 把状态写入链接 hash（不含 ct）
  function mergeStateIntoUrl(targetUrl, rawState) {
    var mergedParams = new URLSearchParams(targetUrl.hash ? targetUrl.hash.substring(1) : '');
    mergedParams.set('_ci', String(rawState.ci));
    mergedParams.set('_iv', String(rawState.iv));
    mergedParams.set('_cy', String(rawState.cy));
    mergedParams.set('_cu', rawState.cu);
    mergedParams.set('_sid', rawState.sid);
    if (rawState.uid) mergedParams.set('_u', rawState.uid);
    // 注意: 不再写入 _ct，ct 通过 localStorage 全局共享
    targetUrl.hash = mergedParams.toString();
    return targetUrl;
  }

  function syncAddressHash(rawState) {
    try {
      var current = new URL(window.location.href);
      var before = current.hash;
      mergeStateIntoUrl(current, rawState);
      if (current.hash !== before && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', current.toString());
      }
    } catch (e) {}
  }

  function shouldSkipLinkPropagation(e, anchor) {
    if (!anchor || !anchor.href) return true;
    if (e.defaultPrevented) return true;
    if (e.button !== 0) return true;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;
    if (anchor.hasAttribute('download')) return true;
    if (anchor.target && anchor.target.toLowerCase() !== '_self') return true;
    return false;
  }

  function attachInSiteLinkPropagation() {
    document.addEventListener('click', function (e) {
      try {
        var anchor = e.target && e.target.closest ? e.target.closest('a') : null;
        if (shouldSkipLinkPropagation(e, anchor)) return;
        var targetUrl = new URL(anchor.href, window.location.href);
        if (targetUrl.origin !== window.location.origin) return;
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return;
        mergeStateIntoUrl(targetUrl, state);
        anchor.href = targetUrl.toString();
        saveState(state);
      } catch (err) {}
    }, true);
  }

  // 解析状态：优先用 hash，fallback 到 storage
  var fromHash = parseStateFromHash();
  var fromStorage = parseStateFromStorage();
  var baseState = fromHash || fromStorage;

  if (!baseState) {
    // 没有任何状态，carousel.js 退出
    return;
  }

  // 获取全局周期开始时间
  var cycleStart = getCycleStart(baseState.cy);

  // 组装最终状态
  var state = {
    ci: baseState.ci,
    ct: cycleStart,
    iv: baseState.iv,
    cy: baseState.cy,
    cu: baseState.cu,
    sid: baseState.sid,
    uid: baseState.uid,
    urls: baseState.urls
  };

  /* ====================================================================
   * Module 2 — 定时器
   * ==================================================================== */

  var intervalSec = state.iv;
  var startTime = state.ct;
  var tickTimer = null;
  var lastHeartbeatSec = -1;

  function elapsed() {
    return Math.floor((Date.now() - startTime) / 1000);
  }

  function tick() {
    var e = elapsed();
    updateUI(e);
    if (e >= 0 && e % HEARTBEAT_INTERVAL_SEC === 0 && e !== lastHeartbeatSec) {
      lastHeartbeatSec = e;
      sendExposure('heartbeat', { dwell_ms: e * 1000 });
    }
    if (e >= intervalSec) {
      navigate();
    }
  }

  /* ====================================================================
   * Module 3 — Wake Lock
   * ==================================================================== */

  var wakeLockSentinel = null;
  var silentVideo = null;

  function requestWakeLock() {
    if ('wakeLock' in navigator && navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen')
        .then(function (sentinel) {
          wakeLockSentinel = sentinel;
          sentinel.addEventListener('release', function () { wakeLockSentinel = null; });
        })
        .catch(function () { ensureSilentVideo(); });
    } else {
      ensureSilentVideo();
    }
  }

  function ensureSilentVideo() {
    try {
      if (silentVideo) return;
      var video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointerEvents:none;zIndex:-1;';
      video.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAAhmcmVlAAABQG1kYXQhEAUgpAABthYQAAAD6GxhdmM1OC4xMzQ=';
      document.body.appendChild(video);
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      silentVideo = video;
    } catch (e) {}
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && !wakeLockSentinel) {
      requestWakeLock();
    }
  }

  /* ====================================================================
   * Module 4 — 跳转逻辑
   * ==================================================================== */

  var navigated = false;

  function navigate() {
    if (navigated) return;
    navigated = true;

    sendExposure('page_leave', { dwell_ms: Date.now() - startTime });
    if (tickTimer) clearInterval(tickTimer);
    try { if (wakeLockSentinel) wakeLockSentinel.release(); } catch (e) {}
    try { if (silentVideo && silentVideo.parentNode) silentVideo.parentNode.removeChild(silentVideo); } catch (e) {}

    var urls = state.urls;
    var nextIndex = state.ci + 1;
    var now = Date.now();

    // 检查是否需要开始新周期
    if (nextIndex >= urls.length || (now - state.ct) >= state.cy * 1000) {
      nextIndex = 0;
      // 新周期，重置全局 cycle start
      state.ct = now;
      try { localStorage.setItem(LS_CYCLE_START, String(now)); } catch (e) {}
    }

    var nextUrl;
    try {
      nextUrl = new URL(urls[nextIndex], window.location.href);
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        console.error('[carousel] Invalid protocol:', nextUrl.protocol);
        return;
      }
    } catch (e) {
      console.error('[carousel] Invalid URL:', urls[nextIndex]);
      return;
    }

    state.ci = nextIndex;
    saveState(state);
    mergeStateIntoUrl(nextUrl, state);
    window.location.href = nextUrl.toString();
  }

  /* ====================================================================
   * Module 5 — UI
   * ==================================================================== */

  var containerEl = null;
  var barEl = null;
  var textEl = null;

  function initUI() {
    containerEl = document.createElement('div');
    containerEl.id = '__carousel_container';
    containerEl.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;zIndex:2147483647;pointerEvents:none;fontFamily:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    barEl = document.createElement('div');
    barEl.id = '__carousel_bar';
    barEl.style.cssText = 'height:4px;width:0%;background:#35a3ff;transition:width 0.25s linear;';

    textEl = document.createElement('div');
    textEl.id = '__carousel_text';
    textEl.style.cssText = 'position:fixed;right:10px;bottom:8px;padding:2px 8px;fontSize:12px;color:#fff;background:rgba(0,0,0,0.55);borderRadius:10px;';
    textEl.textContent = '...';

    containerEl.appendChild(barEl);
    document.body.appendChild(containerEl);
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
    textEl.textContent = pageLabel + ' — ' + timeStr + uidLabel;
  }

  /* ====================================================================
   * 启动
   * ==================================================================== */

  function boot() {
    saveState(state);
    syncAddressHash(state);
    initUI();
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    attachInSiteLinkPropagation();
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
