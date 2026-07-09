const CORE_CACHE = 'arena-core-v1';
const STATIC_CACHE = 'arena-static-v1';
const FONT_CACHE = 'arena-fonts-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CORE_CACHE)
      .then(cache => cache.addAll(CORE_ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => ![CORE_CACHE, STATIC_CACHE, FONT_CACHE].includes(key))
        .map(key => caches.delete(key))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/socket.io/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstWithRefresh(request, STATIC_CACHE));
    return;
  }

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
});

async function handleNavigation(event) {
  const { request, preloadResponse } = event;

  try {
    const preloaded = await preloadResponse;
    if (preloaded) {
      const cache = await caches.open(CORE_CACHE);
      cache.put('/index.html', preloaded.clone());
      return preloaded;
    }

    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CORE_CACHE);
      cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cachedShell = await caches.match('/index.html');
    if (cachedShell) return cachedShell;
    return caches.match('/offline.html');
  }
}

async function cacheFirstWithRefresh(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(response => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || networkFetch || fetch(request);
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then(response => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || networkFetch || fetch(request);
}
