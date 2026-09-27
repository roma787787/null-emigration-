import { test } from "node:test";
import assert from "node:assert/strict";
import { blockRange } from "./blockListener.js";

test("without a cursor only the head is processed", () => {
  assert.deepEqual(blockRange(null, 100n, 2000), { from: 100n, skipped: 0 });
});

test("resumes right after the saved cursor", () => {
  assert.deepEqual(blockRange(90n, 100n, 2000), { from: 91n, skipped: 0 });
});

test("caps a long catch-up to the newest maxCatchup blocks", () => {
  assert.deepEqual(blockRange(0n, 100n, 10), { from: 91n, skipped: 90 });
});

test("nothing to do when the head isn't past the cursor", () => {
  assert.equal(blockRange(100n, 100n, 2000), null);
  assert.equal(blockRange(100n, 99n, 2000), null);
});

test("a cursor far ahead of the chain (another chain's) restarts from the head", () => {
  assert.deepEqual(blockRange(5_000n, 100n, 2000), { from: 100n, skipped: 0 });
  assert.equal(blockRange(120n, 100n, 2000), null, "a small lag behind the cursor just waits");
});
