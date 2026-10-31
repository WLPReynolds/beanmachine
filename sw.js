// Bean Machine service worker — network-first for the app shell so new deploys show up straight away,
// falling back to cache when offline or when the network is too slow to answer (see WAIT). Worker/API calls are never cached here (results live in IndexedDB).
const CACHE = 'beanmachine-v1.3.0';
const PAGE = 'index.html'; // every page load is stored and served under this one name
const SHELL = [PAGE, 'src/app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

// cache: 'reload' skips the browser's HTTP cache, so a new version never precaches an older file
const fresh = u => fetch(new Request(u, { cache: 'reload' }));
// A page load can't be answered with a followed redirect, so hand back a plain copy instead
const unredirect = r => r.redirected
  ? r.blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers }))
  : r;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => fresh(u).then(r => {
        if (!r.ok) throw new Error(`Precache failed for ${u}: HTTP ${r.status}`);
        return c.put(u, r);
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// On a weak signal a request can stall for minutes without failing. After this long, answer from the
// saved copy instead (if there is one) and let the network request finish in the background.
const WAIT = 3000;

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // leave worker calls alone
  const nav = req.mode === 'navigate';
  const key = nav ? PAGE : req;
  let saved = Promise.resolve();
  const net = (nav ? fresh(req.url).then(unredirect) : fetch(req)).then(r => {
    if (r.ok) { const copy = r.clone(); saved = caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  });
  e.waitUntil(net.then(() => saved, () => {})); // keeps a slow download going, so the next open is up to date
  const cached = () => caches.open(CACHE).then(c =>
    c.match(key).then(r => r || c.match(req, { ignoreSearch: true })).then(r => r || c.match(PAGE)));
  e.respondWith(new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    // Nothing saved yet (first visit): keep waiting for the network rather than failing
    const timer = setTimeout(() => cached().then(r => { if (r) finish(r); }), WAIT);
    net.then(r => { clearTimeout(timer); finish(r); },
      () => { clearTimeout(timer); cached().then(r => finish(r || Response.error())); });
  }));
});
