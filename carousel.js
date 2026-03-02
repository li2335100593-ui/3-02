/**
 * Carousel SDK v1.0
 * 客户嵌入脚本 — 从 URL hash 读取轮播状态，自动定时跳转到下一页面
 *
 * Hash 格式: #_ci=<index>&_ct=<cycleStartMs>&_iv=<intervalSec>&_cy=<cycleSec>&_cu=<base64URLs>
 *   _ci  当前页索引（0-based）
 *   _ct  本轮周期开始时间戳（ms）
 *   _iv  每页停留秒数
 *   _cy  整轮周期秒数（超时则重置）
 *   _cu  URL 列表的 Base64 编码（JSON 数组，支持 Unicode）
 */
;(function () {
  'use strict';

  /* ====================================================================
   * Module 1 — 状态管理
   * ==================================================================== */

  /**
   * 从 location.hash 解析轮播参数，处理页面原有 hash 合并的情况
   * @returns {object|null} 解析后的状态对象，无效时返回 null
   */
  function parseState() {
    var raw = window.location.hash;
    if (!raw || raw.length < 2) return null;

    var params = new URLSearchParams(raw.substring(1));

    var ci = params.get('_ci');
    var ct = params.get('_ct');
    var iv = params.get('_iv');
    var cy = params.get('_cy');
    var cu = params.get('_cu');

    // 所有 5 个参数缺一不可
    if (ci === null || ct === null || iv === null || cy === null || cu === null) {
      return null;
    }

    ci = parseInt(ci, 10);
    ct = parseInt(ct, 10);
    iv = parseInt(iv, 10);
    cy = parseInt(cy, 10);

    if (isNaN(ci) || isNaN(ct) || isNaN(iv) || isNaN(cy)) return null;
    if (iv <= 0 || cy <= 0) return null;

    // Base64 解码 URL 列表（支持 Unicode）
    var urls;
    try {
      var decoded = decodeURIComponent(
        atob(cu)
          .split('')
          .map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
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
      cu: cu,       // 原样保留 Base64，透传到下一跳
      urls: urls
    };
  }

  // ── 静默退出：无有效状态 ──
  var state = parseState();
  if (!state) return;

  /* ====================================================================
   * Module 2 — 定时器（timestamp-based）
   * ==================================================================== */

  var intervalSec = state.iv;
  var startTime;  // DOMContentLoaded 时设置

  /**
   * 计算已经过的秒数（基于真实时间戳，防止被节流）
   */
  function elapsed() {
    return Math.floor((Date.now() - startTime) / 1000);
  }

  /**
   * 剩余秒数
   */
  function remaining() {
    var r = intervalSec - elapsed();
    return r > 0 ? r : 0;
  }

  /**
   * 自愈检查 + 定时跳转的核心 tick
   */
  function tick() {
    var elapsedSec = elapsed();

    // 自愈：如果已经超过间隔，立即跳转
    if (elapsedSec >= intervalSec) {
      navigate();
      return;
    }

    // 更新 UI
    updateUI(elapsedSec);
  }

  /* ====================================================================
   * Module 3 — Wake Lock
   * ==================================================================== */

  var wakeLockSentinel = null;
  var silentVideo = null;

  /**
   * 请求 Wake Lock（主方案）
   */
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      fallbackSilentVideo();
      return;
    }
    try {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        wakeLockSentinel = sentinel;
        sentinel.addEventListener('release', function () {
          wakeLockSentinel = null;
        });
      }).catch(function () {
        fallbackSilentVideo();
      });
    } catch (e) {
      fallbackSilentVideo();
    }
  }

  /**
   * 降级方案：创建静音视频循环播放以阻止熄屏
   */
  function fallbackSilentVideo() {
    try {
      if (silentVideo) return;
      // 最小可播放 mp4（约 36 字节的 base64 data URI）
      var mp4 =
        'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1w' +
        'NDEAAAAIZnJlZQAAAAhtZGF0AAAA1m1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAA' +
        'AABAAAAAAAAEAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAgAAACR0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAABA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAgAAAAIAAAAAAEdtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACgAAAAA' +
        'AFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAAAAAAATbWluZgAA' +
        'ABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVy' +
        'bCAAAAAAAAAAAA==';
      var video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('loop', '');
      video.muted = true;
      video.src = mp4;
      video.style.cssText =
        'position:fixed;top:-1px;left:-1px;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
      document.body.appendChild(video);
      video.play().catch(function () {});
      silentVideo = video;
    } catch (e) {
      // 静默失败
    }
  }

  /**
   * visibilitychange 回调：页面恢复可见时重新获取 Wake Lock
   */
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      // 重新获取 Wake Lock
      if (!wakeLockSentinel) {
        requestWakeLock();
      }
      // 自愈：检查是否已超时
      if (startTime && elapsed() >= intervalSec) {
        navigate();
      }
    }
  }

  /* ====================================================================
   * Module 4 — 跳转模块
   * ==================================================================== */

  var navigated = false;  // 防止重复跳转

  /**
   * 构造下一跳 URL 并执行跳转
   */
  function navigate() {
    if (navigated) return;
    navigated = true;

    // 清理定时器和 Wake Lock
    if (tickTimer) clearInterval(tickTimer);
    try {
      if (wakeLockSentinel) wakeLockSentinel.release();
    } catch (e) {}
    try {
      if (silentVideo && silentVideo.parentNode) {
        silentVideo.parentNode.removeChild(silentVideo);
      }
    } catch (e) {}

    var urls = state.urls;
    var nextIndex = state.ci + 1;
    var cycleStart = state.ct;
    var now = Date.now();

    // 周期结束检测
    if (nextIndex >= urls.length || (now - cycleStart) >= state.cy * 1000) {
      nextIndex = 0;
      cycleStart = now;
    }

    // 构造下一跳 URL
    var nextUrl;
    try {
      nextUrl = new URL(urls[nextIndex], window.location.href);
    } catch (e) {
      // URL 无效时尝试原样拼接
      nextUrl = new URL(urls[nextIndex]);
    }

    // 合并目标 URL 的原有 hash 和 carousel 状态参数
    var mergedParams = new URLSearchParams(nextUrl.hash.substring(1));
    mergedParams.set('_ci', String(nextIndex));
    mergedParams.set('_ct', String(cycleStart));
    mergedParams.set('_iv', String(state.iv));
    mergedParams.set('_cy', String(state.cy));
    mergedParams.set('_cu', state.cu);

    nextUrl.hash = mergedParams.toString();

    window.location.href = nextUrl.toString();
  }

  /* ====================================================================
   * Module 5 — UI 模块
   * ==================================================================== */

  var barEl = null;
  var textEl = null;
  var containerEl = null;

  /**
   * 初始化底部进度条 + 倒计时 UI
   */
  function initUI() {
    // 容器
    containerEl = document.createElement('div');
    containerEl.id = '__carousel_container';
    containerEl.style.cssText =
      'position:fixed;bottom:0;left:0;width:100%;height:auto;z-index:2147483647;' +
      'pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    // 倒计时文字
    textEl = document.createElement('div');
    textEl.id = '__carousel_text';
    textEl.style.cssText =
      'position:relative;width:100%;text-align:center;padding:2px 0;' +
      'font-size:11px;line-height:16px;color:rgba(255,255,255,0.9);' +
      'background:rgba(0,0,0,0.55);pointer-events:none;';
    containerEl.appendChild(textEl);

    // 进度条轨道
    var track = document.createElement('div');
    track.id = '__carousel_track';
    track.style.cssText =
      'position:relative;width:100%;height:4px;background:rgba(0,0,0,0.35);';
    containerEl.appendChild(track);

    // 进度条
    barEl = document.createElement('div');
    barEl.id = '__carousel_bar';
    barEl.style.cssText =
      'position:absolute;top:0;left:0;height:100%;width:0%;' +
      'background:linear-gradient(90deg,#00d4ff,#7b2ff7);' +
      'transition:width 0.3s linear;border-radius:0 2px 2px 0;';
    track.appendChild(barEl);

    document.body.appendChild(containerEl);

    // 初始更新
    updateUI(0);
  }

  /**
   * 更新进度条和倒计时文字
   * @param {number} elapsedSec 已过秒数
   */
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
    textEl.textContent = pageLabel + ' \u2014 ' + timeStr;
  }

  /* ====================================================================
   * 启动
   * ==================================================================== */

  var tickTimer = null;

  function boot() {
    startTime = Date.now();

    // 初始化 UI
    initUI();

    // 请求 Wake Lock
    requestWakeLock();

    // 监听 visibilitychange
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 启动 1s 间隔的 tick
    tickTimer = setInterval(tick, 1000);

    // 立即执行一次 tick（处理可能已经超时的情况）
    tick();
  }

  // DOMContentLoaded 时启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
