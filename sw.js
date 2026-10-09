// Phase 0 worker: network first, cache as the fallback, so the family always gets the newest
// test build while online and the installed app still opens offline. Phase 4 replaces this.
const CACHE = 'stackmap-spike';

// Nice to have offline, but never worth failing an install over. The other fonts are cached
// the first time a family picks them.
const EXTRAS = [
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './fonts/comic-relief-regular.woff2',
  './fonts/comic-relief-bold.woff2',
  './sounds/complete_pop.wav',
  './sounds/day_chime.wav',
];

// The first visit's requests all precede the worker, so nothing of it would be cached: fetch
// the shell again here, or the app does not open offline until its SECOND visit. The build's
// file names are hashed, so they are read out of the page and then out of each script — the
// entry names its lazy chunks ("./App-….js", "./App-….css") as quoted relative paths. The drag
// bench is a separate page nothing here names; the `drag-` test only keeps it that way.
async function precache() {
  const cache = await caches.open(CACHE);
  const index = await fetch('./', { cache: 'no-store' });
  if (!index.ok) throw new Error(`precache: ${index.status} for the page`);
  const html = await index.clone().text();
  await cache.put('./', index);

  const named = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => new URL(m[1], self.location.href).href);
  const queue = [...named];
  const seen = new Set(queue);
  while (queue.length) {
    const url = queue.shift();
    const response = await fetch(url);
    if (!response.ok) {
      // A quoted "./x.js" inside a script may not be a file at all: only the page's own are certain.
      if (response.status === 404 && !named.includes(url)) continue;
      throw new Error(`precache: ${response.status} for ${url}`);
    }
    if (url.endsWith('.js')) {
      const text = await response.clone().text();
      for (const m of text.matchAll(/["'`]\.\/([\w.-]+\.(?:js|css))["'`]/g)) {
        const next = new URL(m[1], url).href;
        if (m[1].startsWith('drag-') || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    await cache.put(url, response);
  }

  await Promise.all(
    EXTRAS.map((url) =>
      fetch(url)
        .then((response) => (response.ok ? cache.put(url, response) : undefined))
        .catch(() => undefined),
    ),
  );
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // A failed install is tried again on the next visit; a half-cached shell would not be.
  event.waitUntil(precache());
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // The page itself must come from the SERVER, not the browser's HTTP cache: the host lets a
  // browser keep index.html for ten minutes, and a stale page pins a stale build — reopening
  // the app inside that window brought the old one back. Hashed assets never change, so they
  // may be cached as usual.
  const navigation = request.mode === 'navigate';
  const fresh = navigation ? new Request(request.url, { cache: 'no-store' }) : request;
  event.respondWith(
    fetch(fresh)
      .then((response) => {
        // Only a whole, good answer is worth keeping: a cached 404 would be served offline as
        // if it were the file (and a partial 206 cannot be stored at all).
        if (response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        // One origin, one build: a host's `Vary: Origin` must not hide a precached file from
        // the page's own request for it (it did — a `crossorigin` script never matched).
        const hit = await caches.match(request, { ignoreSearch: true, ignoreVary: true });
        // Only a navigation may fall back to the page: a missing script or JSON answered with
        // index.html and a 200 is worse than a plain failure.
        return hit ?? (navigation ? await caches.match('./') : undefined) ?? Response.error();
      }),
  );
});
