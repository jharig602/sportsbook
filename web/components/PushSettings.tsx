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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");

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

  async function sendTest() {
    setTesting(true);
    setTestResult("");
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      const body = await response.json();
      if (body.ok) {
        setTestResult(`Sent to ${body.sent} device${body.sent === 1 ? "" : "s"}.`);
      } else {
        // Show the delivery error verbatim — a vague message here defeats the point.
        setTestResult(body.error || body.failures?.[0] || "Delivery failed.");
      }
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
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
          {/* What actually pushes, listed from the dispatchers the collector calls. This
              used to promise unusual line moves, which stopped notifying long ago --
              a settings page describing an app that no longer exists. */}
          <p className="mt-1 text-sm text-slate-400">
            Get pushed for the bet of the day and parlay of the day, your team&rsquo;s game
            each week, whether each of your bets won or lost, a price at your books that
            clears the house edge, and your survivor pick before the deadline. Nothing on
            days there is nothing to say.
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={sendTest}
              disabled={testing}
              className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25 disabled:opacity-50"
            >
              {testing ? "Sending…" : "Send a test"}
            </button>
            <button
              onClick={unsubscribe}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-400 ring-1 ring-inset ring-slate-700 transition-colors hover:text-slate-200"
            >
              Turn off
            </button>
          </div>
          {testResult ? (
            <p
              className={`mt-2 text-xs leading-relaxed ${
                testResult.startsWith("Sent")
                  ? "text-emerald-300/90"
                  : "text-rose-300/90"
              }`}
            >
              {testResult}
            </p>
          ) : null}
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            Storing a subscription and delivering to it are different things. Send a test
            so a broken key pair shows up now rather than as a missed alert later.
          </p>
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
