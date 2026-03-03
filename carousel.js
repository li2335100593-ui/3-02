/**
 * Carousel SDK v1.1 (with exposure analytics)
 * 客户嵌入脚本 — 从 URL hash 读取轮播状态，自动定时跳转到下一页面
 *
 * Hash 格式:
 * #_ci=<index>&_ct=<cycleStartMs>&_iv=<intervalSec>&_cy=<cycleSec>&_cu=<base64URLs>[&_sid=<sessionId>]
 */
;(function () {
  'use strict';

  // ===== Analytics Config =====
  var ANALYTICS_URL = 'https://exposure-analytics.li2335100593.workers.dev/api/exposure';
  var HEARTBEAT_INTERVAL_SEC = 30;

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
      return null;
    }
  }

  function sendExposure(eventType, extra) {
    try {
      if (!state) return;
      var payload = {
        event_type: eventType,
        sid: state.sid || null,
        vid: getVid(),
        url: window.location.origin + window.location.pathname,
        page_index: state.ci,
        client_ts: Date.now()
      };

      if (extra && typeof extra === 'object') {
        for (var k in extra) payload[k] = extra[k];
      }

      var body = JSON.stringify(payload);

      // 优先 sendBeacon（跳转前更稳）
      if (navigator.sendBeacon) {
        try {
          var ok = navigator.sendBeacon(
            ANALYTICS_URL,
            new Blob([body], { type: 'application/json' })
          );
          if (ok) return;
        } catch (e) {}
      }

      // 降级 fetch keepalive
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
    } catch (e) {
      return null;
    }
  }

  function parseState() {
    var raw = window.location.hash;
    if (!raw || raw.length < 2) return null;

    var params = new URLSearchParams(raw.substring(1));

    var ci = params.get('_ci');
    var ct = params.get('_ct');
    var iv = params.get('_iv');
    var cy = params.get('_cy');
    var cu = params.get('_cu');
    var sid = params.get('_sid') || createSessionId();

    if (ci === null || ct === null || iv === null || cy === null || cu === null) return null;

    ci = parseInt(ci, 10);
    ct = parseInt(ct, 10);
    iv = parseInt(iv, 10);
    cy = parseInt(cy, 10);

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

    return {
      ci: ci,
      ct: ct,
      iv: iv,
      cy: cy,
      cu: cu, // 原样透传
      sid: sid,
      urls: urls
    };
  }

  var state = parseState();
  if (!state) return; // 无有效状态静默退出

  /* ====================================================================
   * Module 2 — 定时器（timestamp-based）
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

    // heartbeat
    if (e >= 0 && e % HEARTBEAT_INTERVAL_SEC === 0 && e !== lastHeartbeatSec) {
      lastHeartbeatSec = e;
      sendExposure('heartbeat', { dwell_ms: e * 1000 });
    }

    if (e >= intervalSec) {
      navigate();
    }
  }

  /* ====================================================================
   * Module 3 — Wake Lock + 降级
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

      // 1x1 黑色视频（极小）
      video.src =
        'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAAhmcmVlAAABQG1kYXQhEAUgpAABthYQAAAD6GxhdmM1OC4xMzQ=';

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

    // 跳转前上报离开事件（非阻塞）
    sendExposure('page_leave', {
      dwell_ms: Date.now() - startTime
    });

    if (tickTimer) clearInterval(tickTimer);

    try {
      if (wakeLockSentinel) wakeLockSentinel.release();
    } catch (e) {}

    try {
      if (silentVideo && silentVideo.parentNode) silentVideo.parentNode.removeChild(silentVideo);
    } catch (e) {}

    var urls = state.urls;
    var nextIndex = state.ci + 1;
    var cycleStart = state.ct;
    var now = Date.now();

    // 周期结束：重置
    if (nextIndex >= urls.length || (now - cycleStart) >= state.cy * 1000) {
      nextIndex = 0;
      cycleStart = now;
    }

    var nextUrl;
    try {
      nextUrl = new URL(urls[nextIndex], window.location.href);
    } catch (e) {
      // 兜底（一般不会走到）
      window.location.href = urls[nextIndex];
      return;
    }

    // 合并目标 URL 原有 hash + 轮播状态
    var mergedParams = new URLSearchParams(nextUrl.hash ? nextUrl.hash.substring(1) : '');
    mergedParams.set('_ci', String(nextIndex));
    mergedParams.set('_ct', String(cycleStart));
    mergedParams.set('_iv', String(state.iv));
    mergedParams.set('_cy', String(state.cy));
    mergedParams.set('_cu', state.cu);
    mergedParams.set('_sid', state.sid); // 关键：跨域保持同一会话

    nextUrl.hash = mergedParams.toString();
    window.location.href = nextUrl.toString();
  }

  /* ====================================================================
   * Module 5 — UI（4px 底部条 + 倒计时）
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
    textEl.textContent = pageLabel + ' — ' + timeStr;
  }

  /* ====================================================================
   * 启动
   * ==================================================================== */

  function boot() {
    startTime = Date.now();

    initUI();
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 进入页面即上报曝光
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
