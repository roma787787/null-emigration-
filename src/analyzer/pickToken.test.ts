import { test } from "node:test";
import assert from "node:assert/strict";
import { pickReferencedToken } from "./pickToken.js";

const a = { address: "0x" + "aa".repeat(20) };
const b = { address: "0x" + "bb".repeat(20) };

test("picks the token whose address appears in the creation input", () => {
  const input = "0x6080" + "0".repeat(24) + "BB".repeat(20);
  assert.equal(pickReferencedToken([a, b], [input]), b);
});

test("falls back to the first token when none is referenced", () => {
  assert.equal(pickReferencedToken([a, b], ["0x6080"]), a);
});

test("returns null for no candidates", () => {
  assert.equal(pickReferencedToken([], ["0x6080"]), null);
});
