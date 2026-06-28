const CACHE_NAME = "prepbro-static-v9";
const APP_SHELL = [
  "/manifest.webmanifest?v=prepbro-icon-final",
  "/prepbro-favicon-final.png?v=prepbro-icon-final",
  "/prepbro-apple-final.png?v=prepbro-icon-final",
  "/icons/prepbro-64-final.png?v=prepbro-icon-final",
  "/icons/prepbro-192-final.png?v=prepbro-icon-final",
  "/icons/prepbro-512-final.png?v=prepbro-icon-final",
];

function isSameOrigin(requestUrl) {
  return new URL(requestUrl).origin === self.location.origin;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match("/");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  });
  return cached || networkPromise;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .filter((key) => key.startsWith("prepbro-") || key.includes("mindbloom") || key.includes("dyslearn"))
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!isSameOrigin(event.request.url)) return;

  const requestUrl = new URL(event.request.url);
  const isNavigation = event.request.mode === "navigate" || event.request.destination === "document";
  const isStaticAsset = requestUrl.pathname.startsWith("/assets/") || requestUrl.pathname.startsWith("/icons/");

  if (isNavigation) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (isStaticAsset || requestUrl.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});
