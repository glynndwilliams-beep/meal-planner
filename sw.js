// Offline support: keeps the app's own files cached so it opens without a connection.
// Bump VERSION whenever you change any app file so phones pick up the update.
const VERSION = 'meal-planner-v8';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'firebase-config.js',
  'js/app.js',
  'js/store.js',
  'js/ingredients.js',
  'js/scan.js',
  'js/crop.js',
  'js/web.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: network first (so updates arrive), fall back to cache when offline.
  // 'no-cache' makes the browser re-check each file with the server, so an update never
  // mixes new and old files (GitHub Pages otherwise lets browsers reuse files for 10 min).
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
    );
    return;
  }

  // Versioned library files (Firebase SDK, text reader): cache first.
  if (/(^|\.)gstatic\.com$|cdn\.jsdelivr\.net$/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION + '-lib').then(c => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
