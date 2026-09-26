import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfidence, computeConfidenceScore } from "./migrationAnalyzer.js";

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

test("confidence score is 0 with no signals", () => {
  assert.equal(computeConfidenceScore({ tokenBSource: null, functionCount: 0, eventCount: 0, auxiliaryCount: 0 }), 0);
});

test("confidence score weighs a static-call Token B match higher than a constructor-args one", () => {
  const staticScore = computeConfidenceScore({
    tokenBSource: "static_call",
    functionCount: 0,
    eventCount: 0,
    auxiliaryCount: 0,
  });
  const constructorScore = computeConfidenceScore({
    tokenBSource: "constructor_args",
    functionCount: 0,
    eventCount: 0,
    auxiliaryCount: 0,
  });
  assert.ok(staticScore > constructorScore);
});

test("confidence score is capped at 100 even with excess signals", () => {
  const score = computeConfidenceScore({
    tokenBSource: "static_call",
    functionCount: 10,
    eventCount: 10,
    auxiliaryCount: 10,
  });
  assert.equal(score, 100);
});

test("matched functions/events/auxiliary counts are capped at 2 each for scoring", () => {
  const twoFunctions = computeConfidenceScore({
    tokenBSource: null,
    functionCount: 2,
    eventCount: 0,
    auxiliaryCount: 0,
  });
  const fiveFunctions = computeConfidenceScore({
    tokenBSource: null,
    functionCount: 5,
    eventCount: 0,
    auxiliaryCount: 0,
  });
  assert.equal(twoFunctions, fiveFunctions);
});
