// Service Worker - Consulta Llegadas JMC (Conductores)
// Estrategias:
// - App shell (HTML/CSS/JS/iconos):     Cache First con revalidación en background
// - Librerías CDN (Leaflet, supabase):  Cache First
// - Tiles del mapa (OSM):               Network First con fallback a cache
// - API Supabase REST + Edge Functions: Network Only (datos frescos siempre)

const VERSION = "consulta-v6";
const CACHE_APP = "jmc-consulta-app-" + VERSION;
const CACHE_CDN = "jmc-consulta-cdn-" + VERSION;
const CACHE_TILES = "jmc-consulta-tiles-" + VERSION;

// Recursos del app shell que precacheamos al instalar
const APP_SHELL = [
    "./",
    "./index.html",
    "./css/style.css",
    "./js/config.js",
    "./js/main.js",
    "./manifest.webmanifest",
    "./icons/favicon.svg",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-maskable-512.png",
];

// CDN externos: los precacheamos en una caché aparte durante el install
const CDN_PRECACHE = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
    "https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;900&display=swap",
];

// Recursos de CDN que cacheamos en cuanto se piden
const CDN_HOSTS = [
    "unpkg.com",
    "cdn.jsdelivr.net",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
];

// Hosts del API que NO debemos cachear (datos en tiempo real)
const API_HOSTS = [
    "cbplebkmxrkaafqdhiyi.supabase.co",
];

// Hosts de tiles del mapa
const TILE_HOSTS = [
    "tile.openstreetmap.org",
    "a.tile.openstreetmap.org",
    "b.tile.openstreetmap.org",
    "c.tile.openstreetmap.org",
];

// ============== INSTALACIÓN ==============
self.addEventListener("install", (event) => {
    event.waitUntil(
        Promise.all([
            caches.open(CACHE_APP).then((cache) =>
                Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
            ),
            caches.open(CACHE_CDN).then((cache) =>
                Promise.allSettled(CDN_PRECACHE.map((url) =>
                    cache.add(new Request(url, { mode: "no-cors" }))
                ))
            ),
        ]).then(() => self.skipWaiting())
    );
});

// ============== ACTIVACIÓN ==============
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

// ============== FETCH ==============
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // 1. API Supabase: Network Only, no cache (datos frescos)
    if (API_HOSTS.includes(url.hostname)) {
        return;
    }

    // 2. Tiles del mapa: Network First, fallback a cache
    if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
        event.respondWith(networkFirst(req, CACHE_TILES, 200));
        return;
    }

    // 3. CDN externos (Leaflet, supabase-js, fonts): Cache First
    if (CDN_HOSTS.some((h) => url.hostname.endsWith(h))) {
        event.respondWith(cacheFirst(req, CACHE_CDN));
        return;
    }

    // 4. Misma origen (app shell): Cache First con revalidación
    if (url.origin === self.location.origin) {
        event.respondWith(staleWhileRevalidate(req, CACHE_APP));
        return;
    }
});

// ============== ESTRATEGIAS ==============
async function cacheFirst(req, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
    } catch (err) {
        return cached || Response.error();
    }
}

async function networkFirst(req, cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    try {
        const fresh = await fetch(req);
        if (fresh.ok) {
            cache.put(req, fresh.clone());
            if (maxEntries) trimCache(cacheName, maxEntries);
        }
        return fresh;
    } catch (err) {
        const cached = await cache.match(req);
        return cached || Response.error();
    }
}

async function staleWhileRevalidate(req, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
    }).catch(() => cached);
    return cached || fetchPromise;
}

async function trimCache(cacheName, maxItems) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
        await cache.delete(keys[0]);
        trimCache(cacheName, maxItems);
    }
}

// Mensaje para forzar update (lo usa el cliente desde main.js)
self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") self.skipWaiting();
});
