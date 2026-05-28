import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../carousel.js', import.meta.url), 'utf8');

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

async function runCarousel({ urls, seconds, tickMs }) {
  const start = Date.parse('2026-05-28T00:00:00.000Z');
  let currentTime = start;
  let nextTimerId = 1;
  const intervals = new Map();
  const events = [];
  const navigations = [];
  const storage = new Map();
  const listeners = new Map();
  const initial = new URL(urls[0]);
  initial.hash = new URLSearchParams({
    _ci: '0',
    _ct: String(start),
    _iv: '300',
    _cy: '3600',
    _cu: b64(JSON.stringify(urls)),
    _sid: 'sid_test',
    _u: 'SINGLE_URL_SOAK',
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
      events.push(JSON.parse(String(opts.body)));
      return Promise.resolve({ ok: true });
    },
    localStorage: {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: {
      sendBeacon(_url, blob) {
        if (blob && typeof blob.text === 'function') {
          blob.text().then((text) => events.push(JSON.parse(text)));
        }
        return true;
      },
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

  async function drainMicrotasks(rounds = 20) {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  }

  const end = start + seconds * 1000;
  while (currentTime < end) {
    currentTime += tickMs;
    for (const fn of [...intervals.values()]) fn();
    await drainMicrotasks();
  }
  await drainMicrotasks(50);

  return { events, navigations, href: location.href, activeIntervals: intervals.size };
}

const single = await runCarousel({
  urls: ['https://livingroom-design.ddmmoney.com/'],
  seconds: 2 * 60 * 60,
  tickMs: 31 * 1000,
});

const byType = single.events.reduce((acc, ev) => {
  acc[ev.event_type] = (acc[ev.event_type] || 0) + 1;
  return acc;
}, {});

assert.equal(byType.page_enter, 1, 'single-page soak should enter once');
assert.equal(byType.page_leave || 0, 0, 'same-document slot advance should not fake page leaves');
assert.ok(
  byType.heartbeat >= 240,
  `expected at least 240 heartbeats across 2h with drift, got ${byType.heartbeat || 0}`,
);
assert.equal(single.navigations.length, 0, 'same-document rotation must not assign location.href');
assert.equal(single.activeIntervals, 1, 'timer must remain active after same-document slot rollover');

console.log(JSON.stringify({ ok: true, byType, activeIntervals: single.activeIntervals }, null, 2));
