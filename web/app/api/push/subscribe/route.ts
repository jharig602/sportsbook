import { NextResponse } from "next/server";

import { deleteSubscription, saveSubscription } from "@/lib/push";

interface SubscriptionBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export async function POST(request: Request) {
  let body: SubscriptionBody;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Body is not valid JSON.", { status: 400 });
  }

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return new NextResponse("Subscription is missing endpoint or keys.", { status: 400 });
  }
  // Push endpoints are URLs the server will later POST to. Only accept the browser
  // vendors' own https endpoints, so a crafted body cannot turn this into an open relay.
  let host: string;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") throw new Error("insecure");
    host = url.hostname;
  } catch {
    return new NextResponse("Endpoint is not a valid https URL.", { status: 400 });
  }

  const allowed = [
    "android.googleapis.com",
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "notify.windows.com",
    "web.push.apple.com",
  ];
  if (!allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return new NextResponse("Unrecognised push endpoint host.", { status: 400 });
  }

  try {
    await saveSubscription({
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new NextResponse(`Could not store subscription: ${message}`, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { endpoint } = await request.json();
    if (!endpoint) return new NextResponse("Missing endpoint.", { status: 400 });
    await deleteSubscription(endpoint);
    return NextResponse.json({ ok: true });
  } catch {
    return new NextResponse("Could not remove subscription.", { status: 500 });
  }
}
