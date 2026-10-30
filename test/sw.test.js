// Runs sw.js against a fake network, HTTP cache and Cache Storage, to check what is served offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ORIGIN = 'https://lottolab.test';
const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const abs = u => new URL(u, ORIGIN + '/').href;

function makeSW() {
  const site = new Map();      // what the server currently returns
  const httpCache = new Map(); // what the browser's HTTP cache still holds (possibly old)
  let online = true;
  let delay = 0; // a weak signal: requests take this long (real ms) before they answer
  const fetchLog = [];

  async function fakeFetch(input) {
    const req = input instanceof Request ? input : new Request(abs(input));
    const u = new URL(req.url); const k = u.pathname === '/' ? '/index.html' : u.pathname;
    fetchLog.push({ url: req.url, cache: req.cache });
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (!online) throw new TypeError('Failed to fetch');
    if (req.cache !== 'reload' && req.cache !== 'no-store' && httpCache.has(k)) return new Response(httpCache.get(k));
    if (!site.has(k)) return new Response('not found', { status: 404 });
    httpCache.set(k, site.get(k));
    return new Response(site.get(k));
  }

  const stores = new Map();
  const keyOf = (r, o = {}) => { const u = new URL(typeof r === 'string' ? abs(r) : r.url); if (o.ignoreSearch) u.search = ''; return u.href; };
  const open = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      put: async (r, res) => { m.set(keyOf(r), await res.text()); },
      addAll: async list => {
        const rs = await Promise.all(list.map(async u => { const r = await fakeFetch(u); if (!r.ok) throw new TypeError('addAll ' + u); return [u, await r.text()]; }));
        for (const [u, t] of rs) m.set(keyOf(u), t);
      },
      match: async (r, o = {}) => {
        const want = keyOf(r, o);
        for (const [k, v] of m) if ((o.ignoreSearch ? keyOf(k, o) : k) === want) return new Response(v);
        return undefined;
      },
    };
  };
  const caches = {
    open: async name => open(name),
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    match: async (r, o) => { for (const n of stores.keys()) { const x = await open(n).match(r, o); if (x) return x; } },
  };

  const handlers = {};
  const self = { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  // In a real worker, relative URLs resolve against the worker's own address
  class SWRequest extends Request { constructor(u, o) { super(typeof u === 'string' ? abs(u) : u, o); } }
  vm.runInNewContext(src, { self, caches, fetch: fakeFetch, Request: SWRequest, Response, URL, Promise, Error, TypeError, location: new URL(ORIGIN + '/sw.js'),
    // Worker time runs 100× faster, so its 3-second wait takes 30 ms here
    setTimeout: (f, ms) => setTimeout(f, ms / 100), clearTimeout });

  async function lifecycle(type) {
    const waits = [];
    handlers[type]({ waitUntil: p => waits.push(p) });
    await Promise.all(waits);
  }
  // Like request(), but answers as soon as the page has a response, without waiting for background work
  function requestNow(url, { navigate = false } = {}) {
    const req = new Request(abs(url));
    let resp; const waits = [];
    const e = { request: navigate ? { url: req.url, method: 'GET', mode: 'navigate' } : req,
      respondWith: p => { resp = p; }, waitUntil: p => waits.push(p) };
    handlers.fetch(e);
    const t0 = Date.now();
    return { response: resp.then(async r => ({ type: r.type, text: await r.text(), ms: Date.now() - t0 })), background: Promise.all(waits) };
  }
  async function request(url, { navigate = false } = {}) {
    const req = new Request(abs(url));
    let resp; const waits = [];
    const e = { request: navigate ? { url: req.url, method: 'GET', mode: 'navigate' } : req,
      respondWith: p => { resp = p; }, waitUntil: p => waits.push(p) };
    handlers.fetch(e);
    if (!resp) return null; // not handled
    const r = await resp; await Promise.all(waits);
    return r ? r.text() : undefined;
  }
  return { site, httpCache, fetchLog, setOnline: v => { online = v; }, setDelay: ms => { delay = ms; }, lifecycle, request, requestNow, stores };
}

const SHELL_FILES = ['/src/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
function seed(sw, page) {
  sw.site.set('/index.html', page);
  for (const f of SHELL_FILES) sw.site.set(f, 'file ' + f);
}

test('install ignores a stale HTTP-cached page (the bug seen on 25 Oct)', async () => {
  const sw = makeSW();
  seed(sw, 'NEW page');
  sw.httpCache.set('/index.html', 'OLD page'); // the browser still has the previous version cached
  await sw.lifecycle('install');
  await sw.lifecycle('activate');
  sw.setOnline(false);
  assert.equal(await sw.request('/index.html', { navigate: true }), 'NEW page');
  assert.equal(await sw.request('/', { navigate: true }), 'NEW page', "'/' and index.html give the same page");
  assert.ok(sw.fetchLog.filter(f => /index\.html$/.test(f.url)).every(f => f.cache === 'reload'));
});

test('an online page load refreshes the offline copy, whatever address it used', async () => {
  const sw = makeSW();
  seed(sw, 'v1');
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  sw.site.set('/index.html', 'v2');
  sw.httpCache.set('/index.html', 'v1'); // even with an old copy in the HTTP cache
  assert.equal(await sw.request('/', { navigate: true }), 'v2');
  sw.setOnline(false);
  assert.equal(await sw.request('/index.html?app=x', { navigate: true }), 'v2');
});

test('offline: the versioned script is served from the precached copy', async () => {
  const sw = makeSW();
  seed(sw, 'page');
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  sw.setOnline(false);
  assert.equal(await sw.request('/src/app.js?v=9.9.9'), 'file /src/app.js');
});

test('error responses never replace the cached copy', async () => {
  const sw = makeSW();
  seed(sw, 'good');
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  sw.site.delete('/src/app.js');
  await sw.request('/src/app.js');
  sw.setOnline(false);
  assert.equal(await sw.request('/src/app.js'), 'file /src/app.js');
});

test('install fails loudly if a shell file is missing', async () => {
  const sw = makeSW();
  seed(sw, 'page');
  sw.site.delete('/icon-512.png');
  await assert.rejects(sw.lifecycle('install'), /icon-512\.png/);
});

test('activate deletes old caches; other origins are left alone', async () => {
  const sw = makeSW();
  seed(sw, 'page');
  sw.stores.set('beanmachine-v0.0.1', new Map());
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  assert.deepEqual([...sw.stores.keys()].filter(k => k.startsWith('beanmachine-')).length, 1);
  assert.equal(await sw.request('https://lotto-lab-proxy.example.workers.dev/history'), null);
});

test('weak signal: the saved page opens after the short wait instead of hanging', async () => {
  const sw = makeSW();
  seed(sw, 'v1');
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  sw.site.set('/index.html', 'v2');
  sw.setDelay(400); // like a stalled connection: far longer than the worker's wait
  const { response, background } = sw.requestNow('/', { navigate: true });
  const r = await response;
  assert.equal(r.text, 'v1', 'the saved copy is shown');
  assert.ok(r.ms < 250, `answered in ${r.ms} ms, before the network`);
  await background; // the slow download still finishes and refreshes the saved copy
  sw.setDelay(0); sw.setOnline(false);
  assert.equal(await sw.request('/', { navigate: true }), 'v2', 'next open shows the new version');
});

test('weak signal: the script is also served from the saved copy', async () => {
  const sw = makeSW();
  seed(sw, 'page');
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  sw.setDelay(400);
  const r = await sw.requestNow('/src/app.js?v=9.9.9').response;
  assert.equal(r.text, 'file /src/app.js');
  assert.ok(r.ms < 250);
});

test('a slow but working network still wins if it answers within the wait', async () => {
  const sw = makeSW();
  seed(sw, 'v1');
  await sw.lifecycle('install'); await sw.lifecycle('activate');
  sw.site.set('/index.html', 'v2');
  sw.setDelay(5); // well under the 30 ms (scaled 3 s) wait
  assert.equal((await sw.requestNow('/', { navigate: true }).response).text, 'v2');
});

test('nothing saved yet: a slow network is waited for, not given up on', async () => {
  const sw = makeSW();
  seed(sw, 'v1'); // no install, so nothing is cached
  sw.setDelay(100);
  assert.equal((await sw.requestNow('/', { navigate: true }).response).text, 'v1');
});

test('nothing saved and no connection: the request fails rather than hanging', async () => {
  const sw = makeSW();
  seed(sw, 'v1');
  sw.setOnline(false);
  const r = await sw.requestNow('/', { navigate: true }).response;
  assert.equal(r.type, 'error', 'a network error, which the browser shows as its offline page');
});
