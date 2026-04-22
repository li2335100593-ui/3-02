/**
 * Carousel SDK v2.0 (with user identity + exposure analytics)
 * 客户嵌入脚本 — 从 URL hash 读取轮播状态 + 播放人员身份，自动定时跳转
 *
 * Hash 格式:
 * #_ci=<index>&_ct=<cycleStart>&_iv=<interval>&_cy=<cycle>&_cu=<base64urls>&_sid=<sessionId>&_u=<userId>
 */
;(function () {
  'use strict';

  // ===== Analytics Config =====
  var ANALYTICS_URL = 'https://exposure-analytics.li2335100593.workers.dev/api/exposure';
  var HEARTBEAT_INTERVAL_SEC = 30;
  var STATE_STORAGE_KEY = '__carousel_state_v1';
  var STATE_STORAGE_KEY_LOCAL = '__carousel_state_v1_local';

  function createSessionId() {
    return 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function getVid() {
    try {
      var key = '__carousel_vid';
      var vid = localStorage.getItem(key);
      if (!vid) {
        vid = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(key, vid);
      }
      return vid;
    } catch (e) {
      // MEDIUM-RISK FIX: localStorage unavailable in private mode - generate fallback VID
      console.warn('[carousel] localStorage unavailable (private mode?), using generated VID');
      return 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    }
  }

  // ===== 上报（新增 uid 字段） =====
  function sendExposure(eventType, extra) {
    try {
      if (!state) return;
      var payload = {
        event_type: eventType,
        sid: state.sid || null,
        vid: getVid(),
        uid: state.uid || null,          // ← 新增：播放人员身份
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
          var beaconOk = navigator.sendBeacon(
            ANALYTICS_URL,
            new Blob([body], { type: 'application/json' })
          );
          if (beaconOk) return;
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
   * Module 1 — 状态管理（新增 _u 字段）
   * ==================================================================== */

  function decodeBase64Unicode(b64) {
    try {
      var binary = atob(b64);
      var bytes = [];
      for (var i = 0; i < binary.length; i++) {
        bytes.push('%' + ('00' + binary.charCodeAt(i).toString(16)).slice(-2));
      }
      return decodeURIComponent(bytes.join(''));
    } catch (e) {
      return null;
    }
  }

  function normalizeStateObject(rawState) {
    if (!rawState) return null;

    var ci = parseInt(rawState.ci, 10);
    var ct = parseInt(rawState.ct, 10);
    var iv = parseInt(rawState.iv, 10);
    var cy = parseInt(rawState.cy, 10);
    var cu = rawState.cu;
    var sid = rawState.sid || createSessionId();
    var uid = rawState.uid || null;       // ← 新增

    if (cu == null) return null;
    if (isNaN(ci) || isNaN(ct) || isNaN(iv) || isNaN(cy)) return null;
    if (iv <= 0 || cy <= 0) return null;

    var decoded = decodeBase64Unicode(cu);
    if (!decoded) return null;

    var urls;
    try {
      urls = JSON.parse(decoded);
    } catch (e) {
      return null;
    }

    if (!Array.isArray(urls) || urls.length === 0) return null;
    if (ci < 0 || ci >= urls.length) ci = 0;

    return {
      ci: ci,
      ct: ct,
      iv: iv,
      cy: cy,
      cu: cu,
      sid: sid,
      uid: uid,                           // ← 新增
      urls: urls
    };
  }

  function stateSnapshot(rawState) {
    var snap = {
      ci: rawState.ci,
      ct: rawState.ct,
      iv: rawState.iv,
      cy: rawState.cy,
      cu: rawState.cu,
      sid: rawState.sid
    };
    if (rawState.uid) snap.uid = rawState.uid;  // ← 新增
    return snap;
  }

  function loadStateFromStorage() {
    try {
      var saved = sessionStorage.getItem(STATE_STORAGE_KEY);
      if (!saved) {
        // fallback to localStorage (cross-page within same origin)
        saved = localStorage.getItem(STATE_STORAGE_KEY_LOCAL);
      }
      if (!saved) return null;
      var parsed = JSON.parse(saved);
      if (!parsed || !parsed.state) return null;
      return normalizeStateObject(parsed.state);
    } catch (e) {
      return null;
    }
  }

  function saveStateToStorage(rawState) {
    try {
      var payload = {
        state: stateSnapshot(rawState),
        saved_at: Date.now()
      };
      var payloadStr = JSON.stringify(payload);
      sessionStorage.setItem(STATE_STORAGE_KEY, payloadStr);
      localStorage.setItem(STATE_STORAGE_KEY_LOCAL, payloadStr);
    } catch (e) {}
  }

  function mergeStateIntoUrl(targetUrl, rawState) {
    var mergedParams = new URLSearchParams(targetUrl.hash ? targetUrl.hash.substring(1) : '');
    mergedParams.set('_ci', String(rawState.ci));
    mergedParams.set('_ct', String(rawState.ct));
    mergedParams.set('_iv', String(rawState.iv));
    mergedParams.set('_cy', String(rawState.cy));
    mergedParams.set('_cu', rawState.cu);
    mergedParams.set('_sid', rawState.sid);
    if (rawState.uid) {
      mergedParams.set('_u', rawState.uid);   // ← 新增：传递身份
    }
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

  function propagateStateToAnchor(anchor) {
    try {
      if (!anchor || !anchor.href) return;
      var targetUrl = new URL(anchor.href, window.location.href);
      if (targetUrl.origin !== window.location.origin) return;
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return;

      mergeStateIntoUrl(targetUrl, state);
      anchor.href = targetUrl.toString();
      saveStateToStorage(state);
    } catch (err) {}
  }

  function attachInSiteLinkPropagation() {
    // Capture phase to intercept before page scripts handle the click
    document.addEventListener('click', function (e) {
      var anchor = e.target && e.target.closest ? e.target.closest('a') : null;
      if (shouldSkipLinkPropagation(e, anchor)) return;
      propagateStateToAnchor(anchor);
    }, true);

    // Also handle mousedown for faster interception
    document.addEventListener('mousedown', function (e) {
      var anchor = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!anchor || !anchor.href) return;
      if (e.button !== 0) return;
      propagateStateToAnchor(anchor);
    }, true);
  }

  function parseState() {
    var raw = window.location.hash;
    var fromStorage = loadStateFromStorage();

    if (!raw || raw.length < 2) {
      return fromStorage;
    }

    var params = new URLSearchParams(raw.substring(1));

    var fromHash = normalizeStateObject({
      ci: params.get('_ci'),
      ct: params.get('_ct'),
      iv: params.get('_iv'),
      cy: params.get('_cy'),
      cu: params.get('_cu'),
      sid: params.get('_sid') || createSessionId(),
      uid: params.get('_u') || null          // ← 新增：从 hash 读取 _u
    });

    // hash 存在但参数无效（如只有锚点 #section1），fallback 到 storage
    if (!fromHash) {
      return fromStorage;
    }

    // 如果 hash 里的 ct 非常新（<5秒），但 storage 里有更旧的 ct，
    // 说明 hash 可能被错误地重置了，优先用 storage 里的旧 ct
    if (fromStorage && fromStorage.ct) {
      var now = Date.now();
      var hashCtAge = now - fromHash.ct;
      var storageCtAge = now - fromStorage.ct;
      if (hashCtAge < 5000 && storageCtAge > hashCtAge && storageCtAge < fromHash.cy * 1000) {
        // 用 storage 的 ct，但保留 hash 的其他参数（如 ci, uid 等）
        fromHash.ct = fromStorage.ct;
      }
    }

    return fromHash;
  }

  var state = parseState();
  if (!state) return;

  /* ====================================================================
   * Module 2 — 定时器（timestamp-based）— 无变化
   * ==================================================================== */

  var intervalSec = state.iv;
  var startTime = 0;
  var tickTimer = null;
  var lastHeartbeatSec = -1;

  function elapsed() {
    return Math.floor((Date.now() - startTime) / 1000);
  }

  function remaining() {
    var r = intervalSec - elapsed();
    return r > 0 ? r : 0;
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
   * Module 3 — Wake Lock + 降级 — 无变化
   * ==================================================================== */

  var wakeLockSentinel = null;
  var silentVideo = null;

  function requestWakeLock() {
    if ('wakeLock' in navigator && navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen')
        .then(function (sentinel) {
          wakeLockSentinel = sentinel;
          sentinel.addEventListener('release', function () {
            wakeLockSentinel = null;
          });
        })
        .catch(function () {
          ensureSilentVideo();
        });
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
      video.style.position = 'fixed';
      video.style.width = '1px';
      video.style.height = '1px';
      video.style.opacity = '0';
      video.style.pointerEvents = 'none';
      video.style.zIndex = '-1';
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
   * Module 4 — 跳转逻辑 — 无变化（mergeStateIntoUrl 已自动带 _u）
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
    var cycleStart = state.ct;
    var now = Date.now();

    if (nextIndex >= urls.length || (now - cycleStart) >= state.cy * 1000) {
      nextIndex = 0;
      cycleStart = now;
    }

    var nextUrl;
    try {
      nextUrl = new URL(urls[nextIndex], window.location.href);
      // HIGH-RISK FIX: Validate protocol to prevent javascript: and data: URLs
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        console.error('[carousel] Invalid protocol:', nextUrl.protocol);
        return;
      }
    } catch (e) {
      // Invalid URL format - do not navigate
      console.error('[carousel] Invalid URL:', urls[nextIndex]);
      return;
    }

    state.ci = nextIndex;
    state.ct = cycleStart;
    saveStateToStorage(state);
    mergeStateIntoUrl(nextUrl, state);    // _u 会自动带上
    window.location.href = nextUrl.toString();
  }

  /* ====================================================================
   * Module 5 — UI（新增：显示播放人员身份）
   * ==================================================================== */

  var containerEl = null;
  var barEl = null;
  var textEl = null;

  function initUI() {
    containerEl = document.createElement('div');
    containerEl.id = '__carousel_container';
    containerEl.style.position = 'fixed';
    containerEl.style.left = '0';
    containerEl.style.bottom = '0';
    containerEl.style.width = '100%';
    containerEl.style.zIndex = '2147483647';
    containerEl.style.pointerEvents = 'none';
    containerEl.style.fontFamily = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

    barEl = document.createElement('div');
    barEl.id = '__carousel_bar';
    barEl.style.height = '4px';
    barEl.style.width = '0%';
    barEl.style.background = '#35a3ff';
    barEl.style.transition = 'width 0.25s linear';

    textEl = document.createElement('div');
    textEl.id = '__carousel_text';
    textEl.style.position = 'fixed';
    textEl.style.right = '10px';
    textEl.style.bottom = '8px';
    textEl.style.padding = '2px 8px';
    textEl.style.fontSize = '12px';
    textEl.style.color = '#fff';
    textEl.style.background = 'rgba(0,0,0,0.55)';
    textEl.style.borderRadius = '10px';
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
    // 如果有 uid，显示在角标上
    var uidLabel = state.uid ? ' [' + state.uid + ']' : '';
    textEl.textContent = pageLabel + ' — ' + timeStr + uidLabel;
  }

  /* ====================================================================
   * 启动 — 无变化
   * ==================================================================== */

  function boot() {
    // 使用 cycle start time (state.ct) 作为计时起点，确保同周期内跳转时倒计时连续
    // 但如果 state.ct 非常新（<5秒前），而 localStorage 里有更旧的 ct，说明状态可能被错误重置了
    var now = Date.now();
    var ctAge = now - state.ct;
    if (ctAge < 5000) {
      try {
        var localSaved = localStorage.getItem(STATE_STORAGE_KEY_LOCAL);
        if (localSaved) {
          var localParsed = JSON.parse(localSaved);
          if (localParsed && localParsed.state && localParsed.state.ct) {
            var localCtAge = now - localParsed.state.ct;
            // 如果 localStorage 里的 ct 更旧（但不超过一个周期），用它
            if (localCtAge > ctAge && localCtAge < state.cy * 1000) {
              state.ct = localParsed.state.ct;
              ctAge = now - state.ct;
            }
          }
        }
      } catch (e) {}
    }
    startTime = state.ct;
    saveStateToStorage(state);
    syncAddressHash(state);
    
    // DEBUG: log state source and age to help diagnose reset issues
    console.log('[carousel] boot: ctAge=' + ctAge + 'ms, ct=' + state.ct + ', now=' + now + ', elapsed=' + Math.floor(ctAge/1000) + 's');

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
