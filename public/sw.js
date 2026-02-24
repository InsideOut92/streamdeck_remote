// public/sw.js
const CACHE = "streamdeck-v9";
const ASSETS = [
  "/StreamDeck.html",
  "/Performance.html",
  "/CurseForge.html",
  "/Soundboard.html",
  "/WoWNavigator.html",
  "/manifest.webmanifest",
  "/sw.js",
  "/icon.svg"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API nie cachen
  if (url.pathname.startsWith("/api/")) return;

  const isHTML = e.request.mode === "navigate" || url.pathname.endsWith(".html");

  // HTML: Network-first (damit Updates sofort ziehen)
  if (isHTML) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        const cache = await caches.open(CACHE);
        cache.put(e.request, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(e.request);
        return cached || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Assets: Cache-first
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
