/* Service worker: push delivery plus a minimal offline shell. */

/*
 * Two rules, both learned the hard way.
 *
 * 1. NEVER precache a page that carries data. The old shell cached "/" at install
 *    time, so a phone that installed the app before the collector had run kept a copy
 *    of the board reading "No priced games" -- and served it on any network hiccup,
 *    where it is indistinguishable from the book genuinely having posted nothing. An
 *    empty board is a finding; a cached empty board is a lie about one.
 *
 * 2. Bump CACHE on every change here. `activate` deletes every cache whose key is not
 *    the current one, so a constant name means the old entries are immortal -- the
 *    reason the stale copy above survived deploy after deploy.
 */
// Bumped for the rename: the shell precaches /icon.svg and /manifest.webmanifest,
// both of which changed. Without a new key the old icon and the old name are served
// from cache indefinitely, which is exactly the failure the comment above warns about.
const CACHE = "dissent-v3";

/* Static assets only. Nothing here changes with the odds. */
const SHELL = ["/offline.html", "/icon.svg", "/manifest.webmanifest"];
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one failed URL cannot abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/* Network-only for anything carrying data; a cached price is worse than no price.
   When the network fails, say so -- do not hand back an old board that reads like an
   empty one. */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE).then(
          (cached) =>
            cached ||
            new Response("Offline.", { headers: { "content-type": "text/plain" } }),
        ),
      ),
    );
    return;
  }

  // Static assets may come from cache; they do not go stale in a way that misleads.
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Line moved", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Line moved";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      // Collapse repeats for the same game rather than stacking a wall of alerts.
      tag: payload.tag || "line-alert",
      renotify: Boolean(payload.renotify),
      data: { url: payload.url || "/movers" },
      badge: "/icon.svg",
      icon: "/icon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/movers";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
