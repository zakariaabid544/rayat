// =============================================
// RAYAT Service Worker - Offline Cache
// =============================================
const CACHE_NAME = 'rayat-v1.1-navfix';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Install: pre-cache all assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS_TO_CACHE).catch(() => undefined);
        })
    );
    self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

function isNavigationRequest(request) {
    return request.mode === 'navigate' || request.destination === 'document';
}

function isLocalStaticAsset(url) {
    return url.origin === self.location.origin && (
        url.pathname.endsWith('.js') ||
        url.pathname.endsWith('.css') ||
        url.pathname.endsWith('.html') ||
        url.pathname.endsWith('.json')
    );
}

// Fetch: prefer fresh network for pages and local code assets
self.addEventListener('fetch', event => {
    // Skip non-GET and chrome-extension requests
    if (event.request.method !== 'GET' || event.request.url.startsWith('chrome-extension://')) return;
    const requestUrl = new URL(event.request.url);

    // For API calls: network first, fallback to cache
    if (event.request.url.includes('/api/')) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Always fetch navigations and local source assets from network first
    if (isNavigationRequest(event.request) || isLocalStaticAsset(requestUrl)) {
        event.respondWith(
            fetch(event.request).then(response => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                return caches.match(event.request).then(cached => {
                    if (cached) return cached;
                    if (isNavigationRequest(event.request)) {
                        return caches.match('./index.html');
                    }
                    return undefined;
                });
            })
        );
        return;
    }

    // For everything else: cache first, fallback to network
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Fallback: serve index.html for navigation requests
                if (event.request.mode === 'navigate') return caches.match('./index.html');
            });
        })
    );
});
