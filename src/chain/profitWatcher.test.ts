import { test } from "node:test";
import assert from "node:assert/strict";
import { profitDecision } from "./profitWatcher.js";

test("a profit alert goes out once per climb: at the threshold, then only a step higher, again after a loss", () => {
  assert.equal(profitDecision(4.9, null, 5, 10), "none");
  assert.equal(profitDecision(5, null, 5, 10), "alert");
  assert.equal(profitDecision(12, 5, 5, 10), "none");
  assert.equal(profitDecision(15, 5, 5, 10), "alert");
  // Dipping below the threshold but still in profit keeps the last alert: no flapping around 5%.
  assert.equal(profitDecision(3, 15, 5, 10), "none");
  assert.equal(profitDecision(-1, 15, 5, 10), "reset");
  assert.equal(profitDecision(-1, null, 5, 10), "none");
  assert.equal(profitDecision(null, 15, 5, 10), "none");
});
