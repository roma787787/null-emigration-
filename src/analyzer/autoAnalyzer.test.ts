import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTokens } from "./autoAnalyzer.js";
import type { TokenReference } from "./genericTokenProbe.js";

const ref = (n: number, ...labels: string[]): TokenReference => ({
  address: `0x${String(n).padStart(40, "0")}` as `0x${string}`,
  labels,
});

test("getter names decide: oldToken is A, newToken is B", () => {
  const oldT = ref(1, "oldToken"), newT = ref(2, "newToken");
  const r = orderTokens([newT, oldT], []);
  assert.equal(r.tokenA, oldT);
  assert.equal(r.tokenB, newT);
  assert.ok(r.decided);
});

test("migrateFromLEND makes the LEND() getter Token A (Aave shape)", () => {
  const aave = ref(1, "AAVE"), lend = ref(2, "LEND");
  const r = orderTokens([aave, lend], ["migrateFromLEND"]);
  assert.equal(r.tokenA, lend);
  assert.equal(r.tokenB, aave);
});

test("mkrToSky makes mkr() A and sky() B (Sky shape)", () => {
  const sky = ref(1, "sky"), mkr = ref(2, "mkr");
  const r = orderTokens([sky, mkr], ["mkrToSky"]);
  assert.equal(r.tokenA, mkr);
  assert.equal(r.tokenB, sky);
});

test("a single referenced token is Token A, with no Token B", () => {
  const only = ref(1, "token");
  const r = orderTokens([only], ["migrate"]);
  assert.equal(r.tokenA, only);
  assert.equal(r.tokenB, null);
});

test("two tokens with uninformative names: undecided (left to the liquidity check)", () => {
  const r = orderTokens([ref(1, "constructor"), ref(2, "constructor")], ["migrate"]);
  assert.equal(r.decided, false);
  assert.notEqual(r.tokenA, r.tokenB);
});
