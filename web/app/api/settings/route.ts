import { NextResponse } from "next/server";

import { parseMyBooks } from "@/lib/my-books";
import { getMyBooks, setMyBooks } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * Which books you hold an account at.
 *
 * Stored server-side rather than in the browser because the notification dispatcher
 * runs from cron, with no request behind it, and cannot read a cookie. A preference
 * only the browser knows cannot decide whether to make the phone buzz.
 */
export async function GET() {
  try {
    return NextResponse.json({ books: await getMyBooks() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { books?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  if (!Array.isArray(body.books)) {
    return NextResponse.json({ error: "books must be an array." }, { status: 400 });
  }
  // Validated on the way in as well as on the way out: this decides which prices are
  // worth interrupting you for, so a malformed name should be dropped, not stored.
  const books = parseMyBooks(body.books.map((b) => String(b)).join(","));

  try {
    return NextResponse.json({ books: await setMyBooks(books) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
