import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toFunctionSelector } from "viem";
import { extractDispatcherSelectors } from "./bytecodeSelectors.js";

const artifacts = JSON.parse(readFileSync(new URL("../../e2e/artifacts.json", import.meta.url), "utf8")) as Record<
  string,
  { bytecode: string }
>;

test("finds every external function of a real solc-compiled contract", () => {
  const selectors = extractDispatcherSelectors(artifacts.MigratorWithGetters!.bytecode);
  for (const sig of ["migrate(uint256)", "newToken()", "oldToken()", "rate()"]) {
    assert.ok(selectors.includes(toFunctionSelector(sig)), sig);
  }
});

test("does not misread PUSH data as a PUSH4/EQ pair", () => {
  // PUSH5 whose data contains 0x63 aabbccdd 14 — must be skipped as data.
  assert.deepEqual(extractDispatcherSelectors("0x6463aabbccdd1400"), []);
});

test("recognises a hand-built dispatcher entry", () => {
  // DUP1 PUSH4 0x12345678 EQ
  assert.deepEqual(extractDispatcherSelectors("0x80631234567814"), ["0x12345678"]);
});
