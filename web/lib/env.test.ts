/**
 * Database URL resolution tests.
 *
 * The failure this guards against is silent: if the app cannot find the URL it falls
 * back to the bundled fixture and serves a stale snapshot that looks completely
 * healthy. Nothing errors, nothing looks broken, and the prices are simply wrong.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { databaseUrl, databaseUrlSource, isPooled } from "./env.ts";

const POOLED = "postgresql://u:p@ep-cool-name-123-pooler.us-east-2.aws.neon.tech/neondb";
const DIRECT = "postgresql://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb";

const TOUCHED = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "NEON_DATABASE_URL",
  "STORAGE_POSTGRES_URL",
  "AAA_DATABASE_URL",
  "NOT_A_URL_DATABASE_URL",
  "SOMETHING_ELSE",
];

function clear() {
  for (const name of TOUCHED) delete process.env[name];
}

afterEach(clear);

test("nothing configured resolves to null", () => {
  clear();
  assert.equal(databaseUrl(), null);
  assert.equal(databaseUrlSource(), null);
});

test("DATABASE_URL is preferred", () => {
  clear();
  process.env.DATABASE_URL = POOLED;
  process.env.POSTGRES_URL = DIRECT;
  assert.equal(databaseUrl(), POOLED);
  assert.equal(databaseUrlSource(), "DATABASE_URL");
});

test("POSTGRES_URL is accepted when DATABASE_URL is absent", () => {
  clear();
  process.env.POSTGRES_URL = POOLED;
  assert.equal(databaseUrlSource(), "POSTGRES_URL");
});

test("pooled names outrank the unpooled ones", () => {
  clear();
  process.env.DATABASE_URL_UNPOOLED = DIRECT;
  process.env.POSTGRES_URL = POOLED;
  assert.equal(databaseUrlSource(), "POSTGRES_URL");
});

// --- the prefixed case, which is why this exists -------------------------------

test("a prefixed variable is found when the standard names are taken", () => {
  clear();
  process.env.NEON_DATABASE_URL = POOLED;
  assert.equal(databaseUrl(), POOLED);
  assert.equal(databaseUrlSource(), "NEON_DATABASE_URL");
});

test("any prefix works, not just NEON", () => {
  clear();
  process.env.STORAGE_POSTGRES_URL = POOLED;
  assert.equal(databaseUrlSource(), "STORAGE_POSTGRES_URL");
});

test("a pooled prefixed URL beats a direct one", () => {
  clear();
  process.env.AAA_DATABASE_URL = DIRECT;
  process.env.NEON_DATABASE_URL = POOLED;
  assert.equal(databaseUrlSource(), "NEON_DATABASE_URL");
});

test("prefix matching never overrides an explicit standard name", () => {
  clear();
  process.env.DATABASE_URL = DIRECT;
  process.env.NEON_DATABASE_URL = POOLED;
  assert.equal(databaseUrlSource(), "DATABASE_URL");
});

test("a matching name holding something that is not a postgres URL is ignored", () => {
  clear();
  process.env.NOT_A_URL_DATABASE_URL = "hunter2";
  assert.equal(databaseUrl(), null);
});

test("unrelated variables are never picked up", () => {
  clear();
  process.env.SOMETHING_ELSE = POOLED;
  assert.equal(databaseUrl(), null);
});

// --- pooling detection ---------------------------------------------------------

test("pooled detection", () => {
  assert.equal(isPooled(POOLED), true);
  assert.equal(isPooled(DIRECT), false);
  assert.equal(isPooled(null), false);
});
