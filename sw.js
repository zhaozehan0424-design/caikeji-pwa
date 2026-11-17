const CACHE_NAME = "composite-recall-v2";
const CORE_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=1.0",
  "./app.js?v=1.0",
  "./native.js?v=1.0",
  "./data.js?v=1.0",
  "./manifest.webmanifest?v=1.0",
  "./assets/lucide.min.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/classroom-board.jpg",
  "./assets/classroom-board-rectified.png",
];

const UPDATE_FIRST_FILES = new Set([
  "",
  "index.html",
  "styles.css",
  "app.js",
  "native.js",
  "data.js",
  "manifest.webmanifest",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function cacheResponse(request, response) {
  if (response && response.status === 200 && response.type !== "opaque") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    return await cacheResponse(request, response);
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") return caches.match("./index.html");
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    return await cacheResponse(request, await fetch(request));
  } catch {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const localPath = url.pathname.slice(scope.pathname.length);
  const updateFirst = event.request.mode === "navigate" || UPDATE_FIRST_FILES.has(localPath);
  event.respondWith(updateFirst ? networkFirst(event.request) : cacheFirst(event.request));
});
