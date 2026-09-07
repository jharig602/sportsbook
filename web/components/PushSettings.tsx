"use client";

import { useEffect, useState } from "react";

type Status =
  | "loading"
  | "unsupported"
  | "ios-needs-install"
  | "denied"
  | "ready"
  | "subscribed"
  | "error";

/**
 * VAPID keys travel as base64url. Returned as Uint8Array<ArrayBuffer> specifically:
 * `applicationServerKey` requires a BufferSource, and a plain Uint8Array is typed over
 * ArrayBufferLike, which admits SharedArrayBuffer and so is not assignable.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const view = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    view[index] = raw.charCodeAt(index);
  }
  return view;
}

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari's non-standard flag, still the only reliable signal on iOS.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function PushSettings() {
  const [status, setStatus] = useState<Status>("loading");
  const [detail, setDetail] = useState<string>("");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      // On iOS this is the state until the app is added to the Home Screen — Safari
      // exposes no PushManager in a normal tab, so notifications fail silently and
      // look like a bug unless we say exactly why.
      setStatus(isIos() && !isStandalone() ? "ios-needs-install" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setStatus(subscription ? "subscribed" : "ready"))
      .catch(() => setStatus("ready"));
  }, []);

  async function subscribe() {
    setDetail("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }

      const keyResponse = await fetch("/api/push/key");
      const { publicKey } = await keyResponse.json();
      if (!publicKey) {
        setStatus("error");
        setDetail("No VAPID public key is configured on the server.");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const saved = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription),
      });
      if (!saved.ok) {
        setStatus("error");
        setDetail(await saved.text());
        return;
      }
      setStatus("subscribed");
    } catch (error) {
      setStatus("error");
      setDetail(error instanceof Error ? error.message : String(error));
    }
  }

  async function unsubscribe() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    setStatus("ready");
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-200">Notifications</h2>

      {status === "loading" ? (
        <p className="mt-1 text-sm text-slate-500">Checking&hellip;</p>
      ) : null}

      {status === "ios-needs-install" ? (
        <p className="mt-1 text-sm leading-relaxed text-amber-300/90">
          On iPhone, notifications only work once this app is on your Home Screen. Tap
          Share, then <span className="font-medium">Add to Home Screen</span>, and open it
          from there. In a normal Safari tab iOS provides no push at all.
        </p>
      ) : null}

      {status === "unsupported" ? (
        <p className="mt-1 text-sm text-slate-500">
          This browser does not support web push.
        </p>
      ) : null}

      {status === "denied" ? (
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          Notifications are blocked. Re-enable them for this site in your browser
          settings, then reload.
        </p>
      ) : null}

      {status === "ready" ? (
        <>
          <p className="mt-1 text-sm text-slate-400">
            Get pushed when a line makes an unusual move.
          </p>
          <button
            onClick={subscribe}
            className="mt-2 rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25"
          >
            Enable notifications
          </button>
        </>
      ) : null}

      {status === "subscribed" ? (
        <>
          <p className="mt-1 text-sm text-emerald-300/90">
            Notifications are on for this device.
          </p>
          <button
            onClick={unsubscribe}
            className="mt-2 rounded-lg px-3 py-1.5 text-sm text-slate-400 ring-1 ring-inset ring-slate-700 transition-colors hover:text-slate-200"
          >
            Turn off
          </button>
        </>
      ) : null}

      {status === "error" ? (
        <p className="mt-1 text-sm text-rose-300/90">
          Could not enable notifications. {detail}
        </p>
      ) : null}
    </div>
  );
}
