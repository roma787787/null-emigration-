import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMigrationAlert } from "./notificationFormatter.js";
import type { MigrationContractRecord, TokenRecord } from "../types/index.js";

const token: TokenRecord = {
  id: 1,
  network: "arbitrum",
  address: "0x1234567890123456789012345678901234567890",
  symbol: "OLD",
  name: "Old Token",
  addedByChatId: "42",
  createdAt: new Date(),
};

function migration(overrides: Partial<MigrationContractRecord> = {}): MigrationContractRecord {
  return {
    id: 1,
    tokenId: 1,
    network: "arbitrum",
    contractAddress: "0x9999888877776666555544443333222211110000",
    creatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    tokenBAddress: "0x7777666655554444333322221111000099998888",
    confidence: "HIGH",
    confidenceScore: 90,
    matchedFunctions: ["migrate(uint256)"],
    matchedEvents: [],
    matchedAuxiliary: [],
    tokenBSource: "static_call",
    matchedGetter: "newToken",
    txHash: "0xdead",
    blockNumber: 123n,
    detectedAt: new Date(),
    ...overrides,
  };
}

test("includes the network label, confidence, and matched function", () => {
  const text = formatMigrationAlert(token, migration());

  assert.match(text, /Arbitrum One/);
  assert.match(text, /HIGH CONFIDENCE/);
  assert.ok(text.includes("migrate\\(uint256\\)"));
});

test("includes explorer and DexScreener links when Token B is known", () => {
  const text = formatMigrationAlert(token, migration());

  assert.match(text, /arbiscan\.io\/address/);
  assert.match(text, /dexscreener\.com\/arbitrum/);
});

test("omits the DexScreener link and shows a placeholder when Token B is unknown", () => {
  const text = formatMigrationAlert(
    token,
    migration({ tokenBAddress: null, tokenBSource: null, matchedGetter: null, confidence: "MEDIUM" }),
  );

  assert.doesNotMatch(text, /dexscreener\.com/);
  assert.match(text, /MEDIUM CONFIDENCE/);
});

test("includes the confidence percentage and names the matched getter", () => {
  const text = formatMigrationAlert(token, migration());

  assert.match(text, /90%/);
  assert.ok(text.includes("переменная newToken"));
});

test("names the constructor-args source when Token B came from there", () => {
  const text = formatMigrationAlert(token, migration({ tokenBSource: "constructor_args", matchedGetter: null }));

  assert.ok(text.includes("конструкторе"));
});

test("escapes MarkdownV2 special characters in the token symbol", () => {
  const dottedToken: TokenRecord = { ...token, symbol: "A.B_C" };
  const text = formatMigrationAlert(dottedToken, migration());

  assert.match(text, /A\\\.B\\_C/);
});
