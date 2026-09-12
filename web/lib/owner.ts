/**
 * Whose ledger is this.
 *
 * The app has two kinds of visitor and they need opposite things. The MARKET half —
 * the board, the consensus, the line shopping, the model's track record — is shared by
 * construction: it costs ESPN requests and Neon rows to collect, it is identical for
 * everybody, and it is the actual product. The PERSONAL half — the wagers you logged —
 * is not shared at all, and two people's rows landing in one tally would produce a
 * combined win rate that describes nobody.
 *
 * So every bet carries an owner, and there are exactly two ways to be one.
 *
 * **The house.** Whoever holds APP_PASSCODE is `HOUSE`, a fixed string rather than a
 * random identifier. This is the important asymmetry: `HOUSE` is not a value any cookie
 * can legitimately carry (`validOwnerId` rejects it), so the owner's ledger is not
 * addressable by guessing, claiming, or forging an identifier. It is reached by knowing
 * the passcode and by nothing else. It is also the value the v14 migration backfilled
 * the existing season to, so the record that already exists stays exactly where it was.
 *
 * **Everyone else.** A visitor holding the viewer passcode gets 128 random bits in a
 * cookie the first time they arrive. No email, no password, no name — nothing about
 * them is stored, and the identifier means nothing outside this database. It is closer
 * to a coat check ticket than an account.
 *
 * The cookie is the credential, which is the honest way to say it: anyone holding that
 * value is that ledger. That is an acceptable bar for a personal record of $5 bets and
 * would not be for anything else, so nothing else is ever stored against it.
 */

/** The ledger belonging to whoever holds APP_PASSCODE. Never issued to a cookie. */
export const HOUSE = "owner";

export const OWNER_COOKIE = "dissent_owner";

/** A year. Long, because the thing being kept is a season-long sample. */
export const OWNER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** 128 bits, hex. Web Crypto rather than node:crypto, because middleware mints these. */
export function newOwnerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Whether a cookie value is a well-formed visitor identifier.
 *
 * Deliberately refuses `HOUSE`. A cookie is client-supplied, so without this check a
 * visitor could simply type `dissent_owner=owner` and read the ledger the passcode is
 * there to protect. The shape is also the whole validation: it goes into a parameterised
 * query, but a malformed value that reaches storage would create a ledger nobody can
 * ever return to, which is worse than a refusal.
 */
export function validOwnerId(value: string | undefined): boolean {
  if (!value) return false;
  return /^[0-9a-f]{32}$/.test(value);
}

/**
 * The ledger this request may read and write, or null when it needs a fresh one.
 *
 * Role comes first and wins outright: the owner is the owner whatever cookie is also
 * present. A visitor who later learns the real passcode should see their own season,
 * not the one they were carrying an identifier for.
 */
export function ownerIdFor(
  role: "owner" | "viewer" | null,
  cookie: string | undefined,
): string | null {
  if (role === "owner") return HOUSE;
  if (role !== "viewer") return null;
  return validOwnerId(cookie) ? cookie! : null;
}

/* --- Moving a ledger to a second device ------------------------------------------ */

/**
 * No 0/O, 1/I/L, or 5/S. A code is read off one screen and typed into another, usually
 * a phone, and a character pair that cannot be told apart at a glance turns a working
 * transfer into "it says the code is wrong" with no way to tell which.
 */
const ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";

export const TRANSFER_LENGTH = 8;

/** Fifteen minutes. Long enough to walk to the other device, short enough to matter. */
export const TRANSFER_TTL_MS = 15 * 60 * 1000;

export function newTransferCode(): string {
  const bytes = new Uint8Array(TRANSFER_LENGTH);
  crypto.getRandomValues(bytes);
  // Rejection-free modulo would bias toward the first few letters. 256 is not a
  // multiple of 29, and the bias is tiny -- but "tiny bias in a credential" is the
  // kind of thing that is embarrassing to have written down on purpose.
  let out = "";
  for (let i = 0; i < TRANSFER_LENGTH; i += 1) {
    let b = bytes[i];
    while (b >= 256 - (256 % ALPHABET.length)) {
      const extra = new Uint8Array(1);
      crypto.getRandomValues(extra);
      b = extra[0];
    }
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/**
 * What the user typed, turned into what was issued — or null if it cannot be.
 *
 * BOTH members of each confusable pair are missing from the alphabet, not one: no `0`
 * and no `O`, no `1`/`I`/`L`, no `5`/`S`. So there is nothing to fold and no guessing to
 * do — a code containing any of them was mistyped, and this can say so immediately
 * rather than sending it to the database to come back "no such code" for a reason the
 * person typing cannot see.
 *
 * Uppercasing and stripping spaces and dashes is the whole repair, because those are
 * things people add themselves when copying a code across in chunks.
 */
export function normalizeTransferCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length !== TRANSFER_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function transferExpired(createdAt: string | Date, now = Date.now()): boolean {
  const started = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(started)) return true;
  return now - started > TRANSFER_TTL_MS;
}
