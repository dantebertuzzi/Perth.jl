/* Perth · service worker (PWA).
 * Estratégia network-first com fallback ao cache: o app continua abrindo
 * offline (shell estático), mas nunca serve JS/CSS velho quando o servidor
 * está de pé — coerente com o Cache-Control: no-store do backend.
 * API e WebSocket passam direto (dados nunca são cacheados). */
"use strict";

const CACHE = "perth-static-v1";
const STATIC = ["/", "/style.css", "/app.js", "/logo.png", "/favicon.svg",
                "/shared/ui.css", "/shared/presence.js", "/shared/i18n.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(STATIC))
    .catch(() => null));           // offline no install: segue sem precache
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => null);
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
