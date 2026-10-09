/*
 * KuchPos service worker: the small program the browser keeps so that the checkout can
 * open when there is no internet. Written by hand on purpose (no library); see CLAUDE.md.
 *
 * It does three things and nothing else:
 *  1. keeps a copy of the offline checkout page ("/offline") and the files that page needs;
 *  2. when a page cannot be fetched because there is no internet, shows that copy instead;
 *  3. serves the app's own unchanging files (/_next/static/…) from its copy when it has one.
 *
 * It never keeps a copy of anything else: no sales, no customer pages, no answers from the
 * server. Sales made offline are kept by the page itself, in the browser's database.
 */
const CACHE = "kuchpos-offline-v1";
const OFFLINE_PAGE = "/offline";
const STATIC = "/_next/static/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("kuchpos-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** Every /_next/static/… address mentioned in a piece of text (a page or a stylesheet). */
function staticFilesIn(text) {
  const found = new Set();
  for (const match of text.matchAll(/\/_next\/static\/[A-Za-z0-9_\-./%~@[\]()!]+(\?[A-Za-z0-9_\-=&.%]+)?/g)) {
    // Whatever punctuation followed the address in the text (a bracket, a full stop) is not part of it.
    found.add(match[0].replace(/[^A-Za-z0-9]+$/, ""));
  }
  return [...found];
}

/** Fetches the offline page afresh and keeps it, together with every file it needs. */
async function keepOfflinePage() {
  const cache = await caches.open(CACHE);
  const page = await fetch(OFFLINE_PAGE, { cache: "no-store", credentials: "same-origin" });
  if (!page.ok || page.redirected) throw new Error("The offline page could not be fetched.");
  const html = await page.clone().text();
  const wanted = new Set(staticFilesIn(html));
  // Stylesheets name further files (fonts).
  for (const address of [...wanted]) {
    if (!address.split("?")[0].endsWith(".css")) continue;
    try {
      const sheet = await fetch(address);
      if (sheet.ok) for (const inner of staticFilesIn(await sheet.clone().text())) wanted.add(inner);
    } catch {
      // Left out; the page still works without a font.
    }
  }
  let kept = 0;
  await Promise.all(
    [...wanted].map(async (address) => {
      try {
        if (await cache.match(address)) {
          kept += 1;
          return;
        }
        const file = await fetch(address);
        if (file.ok) {
          await cache.put(address, file);
          kept += 1;
        }
      } catch {
        // One file missing must not stop the rest.
      }
    }),
  );
  // The page goes in last: it is only kept once its files are.
  await cache.put(OFFLINE_PAGE, page);
  // Files of earlier versions of the app are dropped.
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname + new URL(request.url).search;
    if (path !== OFFLINE_PAGE && !wanted.has(path)) await cache.delete(request);
  }
  return { files: wanted.size, kept };
}

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "keep-offline-page") return;
  const answer = event.ports && event.ports[0];
  event.waitUntil(
    keepOfflinePage().then(
      (result) => answer && answer.postMessage({ ok: true, ...result }),
      (error) => answer && answer.postMessage({ ok: false, message: String(error) }),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The app's own files never change under the same name: the copy is as good as the original.
  if (url.pathname.startsWith(STATIC)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const kept = await cache.match(request);
        if (kept) return kept;
        return fetch(request);
      })(),
    );
    return;
  }

  // Opening a page: always from the server when it can be reached. Only when it cannot,
  // the offline checkout is shown instead.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (error) {
          const kept = await (await caches.open(CACHE)).match(OFFLINE_PAGE);
          if (kept) return kept;
          throw error;
        }
      })(),
    );
  }
});
