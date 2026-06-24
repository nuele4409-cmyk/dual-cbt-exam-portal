// ─────────────────────────────────────────────────────────────
//  InsideOAU CBT — Service Worker
//  Strategy:
//    • Static shell (HTML, CSS, JS, icons) → Cache-first
//    • Supabase / Google / external APIs   → Network-only
//    • Fallback: serve cached index.html when offline
// ─────────────────────────────────────────────────────────────

const CACHE = 'insideoau-cbt-v8';

const PRECACHE = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/scripts/main.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── INSTALL: pre-cache the app shell ─────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
});

// ── ACTIVATE: delete stale caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── MESSAGE: allow page to trigger skipWaiting ───────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Always go to network for: Supabase, Google APIs, CDN scripts
  const networkOnly = [
    'supabase.co',
    'googleapis.com',
    'googletagmanager.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'realtime.supabase',
  ];
  if (networkOnly.some(h => url.hostname.includes(h))) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Same-origin assets → cache-first, update cache in background
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(req).then(cached => {
          const networkFetch = fetch(req).then(response => {
            if (response && response.ok) {
              cache.put(req, response.clone());
            