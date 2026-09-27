import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConfidence, computeConfidenceScore, hasFunctionSignal } from "./migrationAnalyzer.js";

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

const noSignals = {
  tokenBSource: null,
  strongFunctionCount: 0,
  weakFunctionCount: 0,
  eventCount: 0,
  auxiliaryCount: 0,
} as const;

test("confidence score is 0 for LOW with no signals", () => {
  assert.equal(computeConfidenceScore("LOW", noSignals), 0);
});

test("confidence score weighs a static-call Token B match higher than a constructor-args one", () => {
  const staticScore = computeConfidenceScore("MEDIUM", { ...noSignals, tokenBSource: "static_call" });
  const constructorScore = computeConfidenceScore("MEDIUM", { ...noSignals, tokenBSource: "constructor_args" });
  assert.ok(staticScore > constructorScore);
});

test("confidence score is capped at 100 even with excess signals", () => {
  const score = computeConfidenceScore("HIGH", {
    tokenBSource: "static_call",
    strongFunctionCount: 10,
    weakFunctionCount: 10,
    eventCount: 10,
    auxiliaryCount: 10,
  });
  assert.equal(score, 100);
});

test("matched functions/events/auxiliary counts are capped at 2 each for scoring", () => {
  const two = computeConfidenceScore("MEDIUM", { ...noSignals, strongFunctionCount: 2 });
  const five = computeConfidenceScore("MEDIUM", { ...noSignals, strongFunctionCount: 5 });
  assert.equal(two, five);
});

test("the score always falls inside its label's band, so the card never says e.g. HIGH (35%)", () => {
  const weakest = { ...noSignals, tokenBSource: "token_a_match" as const, weakFunctionCount: 1 };
  const strongest = {
    tokenBSource: "static_call" as const,
    strongFunctionCount: 2,
    weakFunctionCount: 2,
    eventCount: 2,
    auxiliaryCount: 2,
  };
  const bands = { LOW: [0, 39], MEDIUM: [40, 69], HIGH: [70, 100] } as const;

  for (const level of ["LOW", "MEDIUM", "HIGH"] as const) {
    for (const input of [noSignals, weakest, strongest]) {
      const score = computeConfidenceScore(level, input);
      const [min, max] = bands[level];
      assert.ok(score >= min && score <= max, `${level} score ${score} outside ${min}-${max}`);
    }
  }
});

test("strong migration functions always count as a function signal", () => {
  assert.equal(hasFunctionSignal(1, 0, false), true);
  assert.equal(hasFunctionSignal(1, 0, true), true);
});

test("weak functions (claim/redeem/deposit) count only on non-token contracts", () => {
  assert.equal(hasFunctionSignal(0, 1, false), true);
  // e.g. USDT has redeem(uint256) but is a plain ERC-20 -> no signal
  assert.equal(hasFunctionSignal(0, 1, true), false);
});

test("a strong function outweighs a weak one in the score", () => {
  const strong = computeConfidenceScore("MEDIUM", { ...noSignals, strongFunctionCount: 1 });
  const weak = computeConfidenceScore("MEDIUM", { ...noSignals, weakFunctionCount: 1 });
  assert.ok(strong > weak);
});
