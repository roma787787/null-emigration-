import { test } from "node:test";
import assert from "node:assert/strict";
import type { MigrationAnalysisResult, MigrationContractRecord } from "../types/index.js";
import { recheckOutcome } from "./recheck.js";

const previous: MigrationContractRecord = {
  id: 1,
  tokenId: 1,
  network: "ethereum",
  contractAddress: "0x9999888877776666555544443333222211110000",
  creatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  tokenBAddress: null,
  confidence: "MEDIUM",
  confidenceScore: 52,
  matchedFunctions: ["migrate(uint256)"],
  matchedEvents: [],
  matchedAuxiliary: [],
  tokenBSource: null,
  matchedGetter: null,
  txHash: "0xdead",
  blockNumber: 1n,
  detectedAt: new Date(),
  discovery: "tracked",
  tokenAAddress: null,
  tokenASymbol: null,
  tokenBSymbolUnverified: null,
  rwaSignals: [],
  liquidity: null,
  custodianLabel: null,
};

function next(overrides: Partial<MigrationAnalysisResult>): MigrationAnalysisResult {
  return {
    tokenAAddress: null,
    confidence: previous.confidence,
    confidenceScore: previous.confidenceScore,
    tokenBAddress: null,
    tokenBSource: null,
    matchedGetter: null,
    matchedFunctions: previous.matchedFunctions,
    matchedEvents: [],
    matchedAuxiliary: [],
    tokenBSymbolUnverified: null,
    rwaSignals: [],
    ...overrides,
  };
}

test("Token B appearing after deploy is worth a new alert", () => {
  const outcome = recheckOutcome(
    previous,
    next({ tokenBAddress: "0x7777666655554444333322221111000099998888", tokenBSource: "static_call", confidence: "HIGH", confidenceScore: 96 }),
  );
  assert.equal(outcome, "notify");
});

test("a higher confidence level is worth a new alert", () => {
  assert.equal(recheckOutcome({ ...previous, confidence: "LOW", confidenceScore: 0 }, next({})), "notify");
});

test("a score change within the same level is saved silently", () => {
  assert.equal(recheckOutcome(previous, next({ confidenceScore: 55 })), "update");
});

test("an identical result changes nothing", () => {
  assert.equal(recheckOutcome(previous, next({})), "unchanged");
});
