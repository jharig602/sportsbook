"use client";

import { useEffect } from "react";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // updateViaCache: "none" per the Next.js PWA guide — without it the browser may
    // serve sw.js from its HTTP cache and keep running a stale worker indefinitely,
    // which means a fixed notification bug never actually reaches the device.
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // Registration fails on unsupported browsers and in some private modes. The app
        // works fine without it; only push and offline caching are lost.
      });
  }, []);

  return null;
}
