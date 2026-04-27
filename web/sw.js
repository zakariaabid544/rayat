// =============================================
// RAYAT Service Worker - Offline Cache
// =============================================
// RAYAT FIX - mobile app ready optimization
// RAYAT-FIX: bump service worker cache so the gateway heartbeat rollout is applied immediately.
const CACHE_VERSION = '1.1.32'; // RAYAT-FIX
const CACHE_NAME = `rayat-${CACHE_VERSION}`;
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './admin/index.html',
    './manifest.json',
    './config.js?v=1.1.32',
    './favicon.png',
    './favicon-32.png',
    './favicon.ico',
    './assets/css/public.css?v=1.1.32', // RAYAT-FIX
    './assets/js/analytics-loader.js?v=1.1.32',
    './assets/js/public.js?v=1.1.32', // RAYAT-FIX
    './assets/logo/logo-black.svg',
    './assets/logo/logo-green.svg',
    './assets/logo/logo-white.svg',
    './icons/apple-touch-icon.png',
    './icons/favicon-16x16.png',
    './icons/favicon-32x32.png',
    './icons/favicon-48x48.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './vendor/tailwind/tailwindcss-cdn.js?v=1.1.32',
    './vendor/leaflet/1.9.4/leaflet.css?v=1.1.32',
    './vendor/leaflet/1.9.4/leaflet.js?v=1.1.32',
    './vendor/leaflet/1.9.4/images/layers.png',
    './vendor/leaflet/1.9.4/images/layers-2x.png',
    './vendor/leaflet/1.9.4/images/marker-icon.png',
    './vendor/leaflet/1.9.4/images/marker-icon-2x.png',
    './vendor/leaflet/1.9.4/images/marker-shadow.png',
    './vendor/jspdf/2.5.1/jspdf.umd.min.js?v=1.1.32'
];

// Install: pre-cache all assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await Promise.allSettled(
                ASSETS_TO_CACHE.map((asset) => cache.add(asset))
            );
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
        url.pathname.endsWith('.json') ||
        url.pathname.endsWith('.png') ||
        url.pathname.endsWith('.svg') ||
        url.pathname.endsWith('.ico')
    );
}

function isApiRequest(url) {
    return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

// Fetch: prefer fresh network for pages and local code assets
self.addEventListener('fetch', event => {
    // Skip non-GET and chrome-extension requests
    if (event.request.method !== 'GET' || event.request.url.startsWith('chrome-extension://')) return;
    const requestUrl = new URL(event.request.url);

    // For API calls: network first, fallback to cache
    if (isApiRequest(requestUrl)) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
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
