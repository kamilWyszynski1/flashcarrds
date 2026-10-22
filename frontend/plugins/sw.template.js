/* Fiszki service worker – generated at build time by plugins/pwa.ts */
/* global self, caches, fetch, Response */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `fiszki-shell-${VERSION}`;
const API = 'fiszki-api';
const FONTS = 'fiszki-fonts';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fiszki-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App navigations: network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/index.html')) || Response.error()),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) {
      // Read-only API: fresh when online, last known copy when offline.
      event.respondWith(
        withTimeout(fetch(req), 8000)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(API).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(async () => {
            const hit = await caches.match(req);
            return hit || new Response(JSON.stringify({ error: 'offline', message: 'You are offline.' }), { status: 503, headers: { 'content-type': 'application/json' } });
          }),
      );
      return;
    }
    // Build assets & icons: cache first.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    event.respondWith(
      caches.open(FONTS).then(async (cache) => {
        const hit = await cache.match(req);
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      }),
    );
  }
});
