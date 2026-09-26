import { test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { migrationFunctionSelectors, scanBytecodeForMigrationSelectors } from "./functionSelectors.js";

test("matches a known migration selector embedded in bytecode", () => {
  const selector = toFunctionSelector("migrate(uint256)");
  const bytecode = `0x6080604052` + `63${selector.slice(2)}` + `1415`;

  const matched = scanBytecodeForMigrationSelectors(bytecode);

  assert.ok(matched.includes("migrate(uint256)"));
});

test("is case-insensitive", () => {
  const selector = toFunctionSelector("claim()");
  const bytecode = (`0x63${selector.slice(2)}`).toUpperCase();

  const matched = scanBytecodeForMigrationSelectors(bytecode);

  assert.ok(matched.includes("claim()"));
});

test("returns no matches for unrelated bytecode", () => {
  const matched = scanBytecodeForMigrationSelectors("0x6080604052348015600f57600080fd5b50");
  assert.deepEqual(matched, []);
});

test("every configured signature produces a unique 4-byte selector", () => {
  const seen = new Set<string>();
  for (const { selector } of migrationFunctionSelectors) {
    assert.match(selector, /^0x[0-9a-f]{8}$/);
    seen.add(selector);
  }
  assert.equal(seen.size, migrationFunctionSelectors.length);
});
