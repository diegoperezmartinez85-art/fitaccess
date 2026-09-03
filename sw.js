/**
 * FITACCESS SERVICE WORKER - Offline PWA Support & Cache Strategy
 */

const CACHE_NAME = "fitaccess-v1.0";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./css/theme.css",
  "./js/app.js",
  "./js/scanner.js",
  "./js/white-label.js",
  "./manifest.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(e.request).catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match("./index.html");
        }
      });
    })
  );
});
