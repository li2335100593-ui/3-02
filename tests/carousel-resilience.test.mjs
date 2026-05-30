import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../carousel.js', import.meta.url), 'utf8');
const HARNESS_START = Date.parse('2026-05-28T00:00:00.000Z');

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function makeLocation(initialHref, navigations) {
  let href = initialHref;
  return {
    get href() { return href; },
    set href(v) {
      href = String(v);
      navigations.push(href);
    },
    get origin() { return new URL(href).origin; },
    get pathname() { return new URL(href).pathname; },
    get search() { return new URL(href).search; },
    get hash() { return new URL(href).hash; },
    set hash(v) {
      const u = new URL(href);
      u.hash = v;
      href = u.toString();
    },
  };
}

function createElement() {
  return {
    style: {},
    children: [],
    parentNode: null,
    textContent: '',
    src: '',
    muted: false,
    loop: false,
    autoplay: false,
    setAttribute() {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
    },
    play() {
      return Promise.resolve();
    },
  };
}

async function drainMicrotasks(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function countByType(events) {
  return events.reduce((acc, ev) => {
    acc[ev.event_type] = (acc[ev.event_type] || 0) + 1;
    return acc;
  }, {});
}

function makeHarness({
  urls,
  interval = 300,
  cycle = 3600,
  tickMs = 1000,
  fetchFailures = 0,
  sendBeacon = true,
}) {
  const start = HARNESS_START;
  let currentTime = start;
  let nextTimerId = 1;
  let fetchAttempts = 0;
  const intervals = new Map();
  const delivered = [];
  const attempted = [];
  const navigations = [];
  const storage = new Map();
  const listeners = new Map();
  const initial = new URL(urls[0]);
  initial.hash = new URLSearchParams({
    _ci: '0',
    _ct: String(start),
    _iv: String(interval),
    _cy: String(cycle),
    _cu: b64(JSON.stringify(urls)),
    _sid: 'sid_test',
    _u: 'MATRIX_UID',
  }).toString();

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [currentTime]));
    }
    static now() {
      return currentTime;
    }
  }

  const location = makeLocation(initial.toString(), navigations);
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    cookie: '',
    body: createElement(),
    createElement,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
  };

  const context = {
    Date: FakeDate,
    URL,
    URLSearchParams,
    Blob,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    RegExp,
    Promise,
    console: { log() {}, error() {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    encodeURIComponent,
    decodeURIComponent,
    setInterval(fn) {
      const id = nextTimerId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    fetch(_url, opts = {}) {
      const payload = JSON.parse(String(opts.body));
      attempted.push(payload);
      fetchAttempts += 1;
      if (fetchAttempts <= fetchFailures) {
        return Promise.reject(new Error('synthetic network failure'));
      }
      delivered.push(payload);
      return Promise.resolve({ ok: true });
    },
    localStorage: {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: {
      sendBeacon: sendBeacon
        ? (_url, blob) => {
            if (blob && typeof blob.text === 'function') {
              blob.text().then((text) => delivered.push(JSON.parse(text)));
            }
            return true;
          }
        : undefined,
      wakeLock: { request: () => Promise.reject(new Error('not available')) },
    },
    window: {
      location,
      history: {
        replaceState(_state, _title, href) {
          location.hash = new URL(href).hash;
        },
      },
      screen: { width: 390, height: 844 },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
    },
    document,
  };
  context.window.window = context.window;
  context.window.document = document;
  context.window.navigator = context.navigator;
  context.window.localStorage = context.localStorage;
  context.window.fetch = context.fetch;

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'carousel.js' });

  async function tick(count = 1) {
    for (let i = 0; i < count; i += 1) {
      currentTime += tickMs;
      for (const fn of [...intervals.values()]) fn();
      await drainMicrotasks();
    }
  }

  async function runFor(seconds) {
    const end = currentTime + seconds * 1000;
    while (currentTime < end) await tick();
    await drainMicrotasks(60);
  }

  async function setVisible(visible) {
    document.visibilityState = visible ? 'visible' : 'hidden';
    listeners.get('visibilitychange')?.();
    await drainMicrotasks(60);
  }

  return {
    tick,
    runFor,
    setVisible,
    get delivered() { return delivered; },
    get attempted() { return attempted; },
    get byType() { return countByType(delivered); },
    get navigations() { return navigations; },
    get activeIntervals() { return intervals.size; },
    get href() { return location.href; },
    get queueLength() {
      const raw = storage.get('__carousel_exposure_queue_v1');
      return raw ? JSON.parse(raw).length : 0;
    },
  };
}

const results = [];

{
  const h = makeHarness({
    urls: ['https://livingroom-design.ddmmoney.com/'],
    tickMs: 31_000,
  });
  await h.runFor(2 * 60 * 60);
  assert.equal(h.byType.page_enter, 1, 'single URL should enter once');
  assert.equal(h.byType.page_leave || 0, 0, 'same-document rollover should not fake page_leave');
  assert.ok(h.byType.heartbeat >= 240, `single URL 2h should keep heartbeating, got ${h.byType.heartbeat || 0}`);
  assert.equal(h.navigations.length, 0, 'single URL should not assign location.href to same document');
  assert.equal(h.activeIntervals, 1, 'single URL timer should stay active');
  results.push(['single_url_2h_drift', h.byType]);
}

{
  const h = makeHarness({
    urls: ['https://example.com/a#one', 'https://example.com/a#two'],
    tickMs: 31_000,
  });
  await h.runFor(20 * 60);
  assert.ok(h.byType.heartbeat >= 40, `same path hash rotation should keep heartbeating, got ${h.byType.heartbeat || 0}`);
  assert.equal(h.navigations.length, 0, 'hash-only rotation should not reload the page');
  assert.equal(h.activeIntervals, 1, 'hash-only rotation timer should stay active');
  results.push(['same_path_hash_rotation', h.byType]);
}

{
  const h = makeHarness({
    urls: ['https://one.example/', 'https://two.example/'],
    sendBeacon: false,
  });
  const bootParams = new URLSearchParams(new URL(h.href).hash.substring(1));
  assert.equal(bootParams.get('_st'), String(HARNESS_START), 'session timer should be stamped on first SDK boot');
  await h.runFor(5 * 60 + 2);
  assert.equal(h.byType.page_leave, 1, 'cross-document rotation should send one page_leave');
  assert.equal(h.navigations.length, 1, 'cross-document rotation should assign location.href');
  const nextParams = new URLSearchParams(new URL(h.navigations[0]).hash.substring(1));
  assert.equal(nextParams.get('_st'), String(HARNESS_START), 'session timer should survive cross-document rotation');
  assert.equal(h.activeIntervals, 0, 'cross-document rotation should stop old document timer');
  results.push(['cross_document_rotation', h.byType]);
}

{
  const h = makeHarness({
    urls: ['https://livingroom-design.ddmmoney.com/'],
    fetchFailures: 8,
    sendBeacon: false,
    tickMs: 31_000,
  });
  await h.runFor(20 * 60);
  assert.equal(h.queueLength, 0, 'queued events should flush after network recovers');
  assert.ok(h.byType.heartbeat >= 40, `recovered network should deliver heartbeats, got ${h.byType.heartbeat || 0}`);
  assert.ok(h.attempted.length > h.delivered.length, 'test should actually exercise failed attempts');
  results.push(['network_retry_queue_flush', h.byType]);
}

{
  const h = makeHarness({
    urls: ['https://livingroom-design.ddmmoney.com/'],
    fetchFailures: 3_100,
    sendBeacon: false,
    tickMs: 31_000,
  });
  await h.runFor(24 * 60 * 60);
  assert.ok(h.queueLength > 2_800, `24h offline should retain queued heartbeats, got queue ${h.queueLength}`);
  assert.ok(h.queueLength < 5_000, `24h offline should stay within queue cap, got queue ${h.queueLength}`);
  results.push(['offline_24h_queue_capacity', { queueLength: h.queueLength }]);
}

{
  const h = makeHarness({
    urls: ['https://livingroom-design.ddmmoney.com/'],
  });
  await h.runFor(4 * 60);
  await h.setVisible(false);
  await h.runFor(10 * 60);
  await h.setVisible(true);
  await h.runFor(6 * 60);
  assert.equal(h.byType.page_leave || 0, 0, 'background playback should not create a fake session end');
  assert.ok(h.byType.heartbeat >= 40, `background playback should keep recording heartbeats, got ${h.byType.heartbeat || 0}`);
  results.push(['background_visible_active_dwell', h.byType]);
}

{
  const h = makeHarness({
    urls: ['https://livingroom-design.ddmmoney.com/'],
    tickMs: 10 * 60 * 1000,
  });
  await h.runFor(2 * 60 * 60);
  assert.ok(h.byType.heartbeat < 240, 'long suspension should not flood every missed heartbeat at once');
  assert.equal(h.activeIntervals, 1, 'timer should remain active after long suspension catch-up');
  results.push(['long_suspension_no_flood', h.byType]);
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
