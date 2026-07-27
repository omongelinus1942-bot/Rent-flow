/* RentFlow service worker
   Purpose: make hard reloads work offline. Everything RentFlow needs to boot —
   the HTML shell plus every CDN script/stylesheet it loads (React, Firebase,
   Tailwind, Babel, Recharts, jsPDF, fonts) — is precached here. Firestore's own
   offline persistence (already enabled in index.html) keeps handling your data;
   this file's only job is making sure the app itself can load with no network. */

const CACHE_VERSION = "rentflow-shell-v2";

const APP_SHELL = [
  "./",
  "./index.html",
];

// Every external <script>/<link> the app depends on to boot. Kept in sync with
// the <head> of index.html — if you add/remove/upgrade a CDN dependency there,
// mirror the change here too.
const CDN_ASSETS = [
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Sora:wght@600;700&display=swap",
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0",
  "https://cdn.tailwindcss.com",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/prop-types/15.8.1/prop-types.min.js",
  "https://unpkg.com/recharts@2.12.7/umd/Recharts.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.24.7/babel.min.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js",
];

// Firebase/Firestore/Auth API traffic must always go straight to the network —
// never intercept or cache these, Firestore manages its own offline queueing.
const NEVER_INTERCEPT_HOSTS = new Set([
  "firestore.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "www.googleapis.com",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      // Same-origin shell files
      await Promise.all(
        APP_SHELL.map(async (url) => {
          try {
            await cache.add(url);
          } catch (err) {
            console.warn("[sw] failed to precache", url, err);
          }
        })
      );

      // Cross-origin CDN assets. Fetched with mode:'cors' so we store a real,
      // readable response rather than an opaque one (opaque responses can't
      // safely satisfy the 'cors'-mode requests these <script crossorigin>
      // tags actually make). All of these CDNs send CORS headers.
      await Promise.all(
        CDN_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { mode: "cors" });
            if (res && res.ok) {
              await cache.put(url, res);
            }
          } catch (err) {
            // Best effort only — if this fails (e.g. installing while offline),
            // the runtime fetch handler below will cache it on the next
            // successful online load instead.
            console.warn("[sw] failed to precache", url, err);
          }
        })
      );

      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle simple GETs; POST/PUT etc. (Firestore writes, auth calls)
  // must go straight to the network untouched.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (NEVER_INTERCEPT_HOSTS.has(url.hostname)) return;

  // Top-level page navigations (reloads, direct visits): try the network
  // first so users get the latest shell when online, but fall back to the
  // cached shell the instant the network is unavailable — this is the exact
  // case that was producing "site can't be reached" while offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          const cache = await caches.open(CACHE_VERSION);
          cache.put("./index.html", res.clone());
          return res;
        } catch (err) {
          const cache = await caches.open(CACHE_VERSION);
          return (
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Everything else (CDN scripts/styles/fonts, icons, etc.): cache-first,
  // populating the cache at runtime for anything not precached at install.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const res = await fetch(request);
        if (res && (res.ok || res.type === "opaque")) {
          cache.put(request, res.clone());
        }
        return res;
      } catch (err) {
        return cached || Response.error();
      }
    })()
  );
});
