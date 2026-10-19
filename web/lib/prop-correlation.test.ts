import assert from "node:assert/strict";
import test from "node:test";

import { correlationsFor, measuredKey, positionOf } from "./prop-correlation.ts";

test("positions come from this season's data", () => {
  assert.equal(positionOf("Christian McCaffrey"), "RB");
  assert.equal(positionOf("George Kittle"), "TE");
  assert.equal(positionOf("Nobody At All"), null);
});

test("measured combinations map to their key; unmeasured ones are refused with a reason", () => {
  assert.deepEqual(measuredKey("anytime_td", "RB", null), { key: "atd_rb" });
  assert.deepEqual(measuredKey("rec_yds", "TE", 44.5), { key: "rec_yds_te" });
  assert.deepEqual(measuredKey("pass_tds", "QB", 0.5), { key: "pass_tds_any" });
  for (const refused of [
    measuredKey("pass_tds", "QB", 1.5),
    measuredKey("first_td", "RB", null),
    measuredKey("receptions", "TE", 3.5),
    measuredKey("rush_yds", "QB", 19.5),
    measuredKey("anytime_td", null, null),
  ]) {
    assert.ok("refused" in refused, JSON.stringify(refused));
  }
});

test("pooled correlations: a back's TD moves with his margin and the total", () => {
  const rb = correlationsFor("atd_rb")!;
  assert.ok(rb.rhoMargin > 0.3 && rb.rhoMargin < 0.35 && rb.rhoTotal > 0.25 && rb.rhoTotal < 0.29);
  const te = correlationsFor("rec_yds_te")!;
  assert.ok(Math.abs(te.rhoMargin) < 0.03 && te.rhoTotal > 0.09);
});
