/* advis0r.com service worker — app-shell cache, network-first for API. */
const CACHE = "advis0r-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // API + health: network-first, never cache (data must be fresh).
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
    e.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "content-type": "application/json" } })));
    return;
  }

  // App shell: cache-first, fall back to network.
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match("/index.html"))),
  );
});
