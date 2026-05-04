/* ============================================================
   Service Worker — Rain Radar
   Strategy:
   - App shell (HTML/CSS/JS, icons, Leaflet CDN): Cache First
   - JMA nowcast/RASRF tiles & targetTimes JSON: Network Only (always fresh)
   - GSI basemap tiles: Stale While Revalidate
   ============================================================ */

const VERSION = 'v1.3.0';
const SHELL_CACHE = `rain-radar-shell-${VERSION}`;
const BASEMAP_CACHE = `rain-radar-basemap-${VERSION}`;
const MAX_BASEMAP_ENTRIES = 420;

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './icon-maskable-512.png',
  './404.html',
  // Leaflet CDN
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ---- Install: pre-cache app shell -----------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Use individual adds so a single failure doesn't kill install
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] precache failed:', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ---- Activate: clean old caches -------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== BASEMAP_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---- Fetch: route by URL ---------------------------------------------------

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. JMA rain data (nowcast/RASRF tiles + JSONs): always go to network, never cache.
  //    Data is time-sensitive; stale tiles would be misleading.
  if (url.hostname === 'www.jma.go.jp' && url.pathname.includes('/bosai/')) {
    return; // let browser handle directly
  }

  // 2. GSI basemap tiles: Stale While Revalidate
  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    event.respondWith(staleWhileRevalidate(req, BASEMAP_CACHE));
    return;
  }

  // 3. Same-origin shell assets + Leaflet CDN: Cache First
  if (
    url.origin === self.location.origin ||
    url.hostname === 'unpkg.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // 4. Default: network, fall back to cache if available
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// ---- Strategies ------------------------------------------------------------

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    // Offline & not cached — best effort: return shell index for navigations
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).then(() => trimCache(cacheName, MAX_BASEMAP_ENTRIES));
    }
    return res;
  }).catch(() => null);

  if (cached) return cached;
  const network = await networkPromise;
  return network || Response.error();
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}
