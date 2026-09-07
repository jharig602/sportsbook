"use client";

import { useEffect } from "react";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration fails on unsupported browsers and in some private modes. The app
      // works fine without it; only push and offline caching are lost.
    });
  }, []);

  return null;
}
