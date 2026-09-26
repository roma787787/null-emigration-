import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfidence } from "./migrationAnalyzer.js";

test("HIGH requires both a matched function and a Token B address", () => {
  assert.equal(computeConfidence(true, true), "HIGH");
});

test("MEDIUM when only migration-style functions are present", () => {
  assert.equal(computeConfidence(true, false), "MEDIUM");
});

test("MEDIUM when only a Token B address is found", () => {
  assert.equal(computeConfidence(false, true), "MEDIUM");
});

test("LOW when neither signal is present", () => {
  assert.equal(computeConfidence(false, false), "LOW");
});
