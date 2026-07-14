const CACHE_NAME = "materials-recall-v13";
const CORE_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=13",
  "./app.js?v=13",
  "./native.js?v=13",
  "./data.js?v=13",
  "./manifest.webmanifest?v=13",
  "./robots.txt",
  "./assets/lucide.min.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/questions/01cbe634-92d7-429c-9c85-5d306cedfa73.png",
  "./assets/questions/48a21142-7d7c-4502-bba7-9092acfe965e.png",
  "./assets/questions/501e3433347549e1aa674c8b999f0315.png",
  "./assets/questions/c68293a4-fe00-4f47-b45e-8b3b8d5ea0e3.png",
  "./assets/questions/d61c5e4c43a245b2a41ad450194d7961.png",
  "./assets/questions/ed7cf23418c44884ad9879f67ebb8e08.png",
  "./assets/questions/ffb392dade0b435e953775a8dba4a32d.png",
  "./privacy.html",
  "./support.html",
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
