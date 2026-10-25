// JoloMeet service worker: lets the site be installed as an app and shows a friendly
// page when there is no connection. It never gets in the way of chat or calls:
// it only handles this site's own GET requests (never Supabase, realtime sockets,
// storage or other origins), and it asks the network first, so the newest files
// always win when you're online and the cache is only a fallback.
const CACHE = 'jolomeet-v1';
const OFFLINE_URL = 'offline.html';
const NETWORK_WAIT_MS = 4000; // on a very slow connection, show a saved copy rather than hang

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, 'assets/images/logo-96.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') store(request, response.clone());
    return response;
  });
  network.catch(() => {}); // when the saved copy wins the race, a late failure isn't an error

  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_WAIT_MS));
    const response = await Promise.race([network, timeout]);
    if (response) return response;
    return (await saved(request)) || network;
  } catch {
    return (await saved(request))
      || (request.mode === 'navigate' ? await caches.match(OFFLINE_URL) : null)
      || Response.error();
  }
}

/** A saved copy of this request, or (for pages) of the same page without its query string. */
async function saved(request) {
  return (await caches.match(request))
    || (request.mode === 'navigate' ? caches.match(request, { ignoreSearch: true }) : undefined);
}

/** Keeps the newest copy of each file: a new ?v= version replaces the older one. */
async function store(request, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
    const path = new URL(request.url).pathname;
    for (const key of await cache.keys()) {
      const url = new URL(key.url);
      if (url.pathname === path && key.url !== request.url && request.mode !== 'navigate') await cache.delete(key);
    }
  } catch {
    /* storage full or blocked: the site still works without a saved copy */
  }
}
