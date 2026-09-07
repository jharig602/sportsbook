/**
 * The books you can actually place a bet at.
 *
 * Worth being precise about what this changes and what it must not. The board's best
 * rows sit at offshore books because those books lag, and lagging is exactly why they
 * disagree with the field. Those disagreements are real information about where the
 * market sits, so they belong in the consensus whether or not you hold an account
 * there. What they are not is a bet you can place.
 *
 * So this filters whose *price* is offered, never what that price is measured against.
 * Dropping unreachable books from the consensus too would throw away the very opinions
 * that locate the fair number, and would quietly make every remaining gap look smaller.
 */

export const MY_BOOKS_COOKIE = "my_books";

/** A year. This is a standing preference, not a session detail. */
export const MY_BOOKS_MAX_AGE = 60 * 60 * 24 * 365;

const MAX_NAME = 40;
const MAX_BOOKS = 20;

/**
 * Printable characters only.
 *
 * Written as a code-point test rather than a regex so the source file stays plain
 * ASCII; a character class of literal control characters is invisible in a diff and
 * easy to mangle. Spaces are deliberately allowed, because "ESPN BET" is a book.
 */
function isPrintable(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Book names come from the feed and are echoed back through a cookie, so they are
 * treated as untrusted input: anything empty, over-long, or carrying a control
 * character is dropped rather than stored.
 */
export function parseMyBooks(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name || name.length > MAX_NAME) continue;
    if (!isPrintable(name)) continue;
    seen.add(name);
    if (seen.size >= MAX_BOOKS) break;
  }
  return [...seen].sort();
}

export function serializeMyBooks(books: string[]): string {
  return parseMyBooks(books.join(",")).join(",");
}

/** Whether a row's book is one of yours. An empty selection means "no filter". */
export function isMine(book: string, myBooks: string[]): boolean {
  return myBooks.length === 0 || myBooks.includes(book);
}
