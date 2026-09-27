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
  discovery: "tracked",
  tokenAAddress: null,
  tokenASymbol: null,
  tokenBSymbolUnverified: null,
  rwaSignals: [],
  liquidity: null,
  custodianLabel: null,
    ...overrides,
  };
}

test("includes the network label, confidence, and matched function", () => {
  const text = formatMigrationAlert(token, migration(), "en");

  assert.match(text, /Arbitrum One/);
  assert.match(text, /HIGH CONFIDENCE/);
  assert.ok(text.includes("migrate\\(uint256\\)"));
});

test("includes explorer and DexScreener links when Token B is known", () => {
  const text = formatMigrationAlert(token, migration(), "en");

  assert.match(text, /arbiscan\.io\/address/);
  assert.match(text, /dexscreener\.com\/arbitrum/);
});

test("omits the DexScreener link and shows a placeholder when Token B is unknown", () => {
  const text = formatMigrationAlert(
    token,
    migration({ tokenBAddress: null, tokenBSource: null, matchedGetter: null, confidence: "MEDIUM" }),
    "en",
  );

  assert.doesNotMatch(text, /dexscreener\.com/);
  assert.match(text, /MEDIUM CONFIDENCE/);
});

test("includes the confidence percentage and names the matched getter (ru)", () => {
  const text = formatMigrationAlert(token, migration(), "ru");

  assert.match(text, /90%/);
  assert.ok(text.includes("переменная newToken"));
});

test("names the constructor-args source when Token B came from there (ru)", () => {
  const text = formatMigrationAlert(token, migration({ tokenBSource: "constructor_args", matchedGetter: null }), "ru");

  assert.ok(text.includes("конструкторе"));
});

test("renders the card in Ukrainian when the chat's language is uk", () => {
  const text = formatMigrationAlert(token, migration(), "uk");

  assert.match(text, /ВИЯВЛЕНО КОНТРАКТ МІГРАЦІЇ/);
  assert.match(text, /Мережа/);
});

test("escapes MarkdownV2 special characters in the token symbol", () => {
  const dottedToken: TokenRecord = { ...token, symbol: "A.B_C" };
  const text = formatMigrationAlert(dottedToken, migration(), "en");

  assert.match(text, /A\\\.B\\_C/);
});

test("manual /analyze mode: neutral title, no owner claim, and handles an unknown Token A", () => {
  const text = formatMigrationAlert(null, migration(), "en", { manual: true });

  assert.match(text, /CONTRACT ANALYSIS/);
  assert.doesNotMatch(text, /MIGRATION CONTRACT DETECTED/);
  assert.doesNotMatch(text, /Deployer \/ Owner/);
  assert.match(text, /Token A: _not specified_/);
});

test("lists action functions first and caps the function list", () => {
  const text = formatMigrationAlert(
    token,
    migration({
      matchedFunctions: [
        "migrationEnded()", "_totalLendMigrated()", "migrateFromLEND(uint256)", "migrationStarted()", "migrationPaused()",
      ],
    }),
    "en",
  );

  const found = text.split("\n").find((line) => line.includes("migrateFromLEND"))!;
  assert.ok(found.indexOf("migrateFromLEND") < found.indexOf("migrationEnded"));
  assert.ok(!found.includes("migrationStarted"));
  assert.ok(found.includes("\\+2 more"));
});
