// Offline support: keep the app and course data on the phone.
// Pages and data: use the network when it's there, fall back to the cache on the course.
const CACHE = 'cedarcrest-v1';
const CORE = ['./', './index.html', './data/course.json', './data/terrain.bin', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // weather etc. go straight to the network
  const hashed = url.pathname.includes('/assets/');
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (hashed && cached) return cached; // fingerprinted files never change
      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch (err) {
        if (cached) return cached;
        if (e.request.mode === 'navigate') return cache.match('./index.html');
        throw err;
      }
    }),
  );
});
