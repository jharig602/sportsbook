/* Service worker: push delivery plus a minimal offline shell. */

const CACHE = "lines-v1";
const SHELL = ["/", "/movers", "/record", "/about"];

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

/* Network-first: odds go stale in minutes, so a cached price is worse than no price.
   The cache exists only so the app opens at all with no signal. */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && request.mode === "navigate") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
  );
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
