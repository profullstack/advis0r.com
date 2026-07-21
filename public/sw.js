/* advis0r.com service worker — NO CACHING.
 *
 * This exists only to evict the previous cache-first SW that older browsers
 * still have installed: on activate it deletes every cache, then every fetch is
 * a pure network passthrough. Nothing is ever cached. */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  // Pure passthrough — no caching whatsoever.
  e.respondWith(fetch(e.request));
});
