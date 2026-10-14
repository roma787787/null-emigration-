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

test("includes the network label and matched function, but no analysis status line", () => {
  const text = formatMigrationAlert(token, migration(), "en");

  assert.match(text, /Arbitrum One/);
  assert.doesNotMatch(text, /CONFIDENCE|Analysis status/);
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
  assert.match(text, /not set yet/);
});

test("names the matched getter, without a confidence percentage (ru)", () => {
  const text = formatMigrationAlert(token, migration(), "ru");

  assert.doesNotMatch(text, /90%/);
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

test("a migrate line links the contract's Write Contract tab and the project site, escaped for MarkdownV2", async () => {
  const { migrateLine } = await import("./notificationFormatter.js");
  const { markdownV2Problem } = await import("./markdownV2.js");
  const terms = {
    status: "open" as const, startsAt: null, endsAt: null, ratio: null, funding: null, prices: null,
    links: { migrate: "https://etherscan.io/address/0xabc#writeContract", website: "https://quick.example/convert_(v2)" },
  };
  const line = migrateLine("ru", terms)!;
  assert.equal(line, "🚀 Мигрировать: [через контракт \\(Write Contract\\)](https://etherscan.io/address/0xabc#writeContract) · [сайт проекта](https://quick.example/convert_(v2\\))");
  assert.equal(markdownV2Problem(line), null);
  assert.match(migrateLine("en", { ...terms, links: { migrate: null, website: "https://x.example" } })!, /^🚀 Migrate: \[project site\]\(https:\/\/x\.example\)$/);
  assert.equal(migrateLine("en", { ...terms, links: { migrate: null, website: null } }), null);
  assert.equal(migrateLine("en", { ...terms, links: undefined }), null);
});

test("the team line and the profit card are valid MarkdownV2 in every language", async () => {
  const { termsLines, formatProfitAlert } = await import("./notificationFormatter.js");
  const { markdownV2Problem } = await import("./markdownV2.js");
  const base = { status: "open" as const, startsAt: null, endsAt: null, ratio: null, funding: null, prices: null };
  for (const lang of ["en", "uk", "ru"] as const) {
    for (const team of [{ verdict: "yes" as const, via: "deployer" as const }, { verdict: "yes" as const, via: "owner" as const }, { verdict: "no" as const }]) {
      const text = termsLines(lang, { ...base, team }).join("\n");
      assert.match(text, /👥/);
      assert.equal(markdownV2Problem(text), null, text);
    }
    assert.doesNotMatch(termsLines(lang, { ...base, team: { verdict: "unknown" } }).join("\n"), /👥/);
    const card = formatProfitAlert(
      migration({
        detectedAt: new Date("2026-10-10T00:00:00Z"),
        terms: {
          ...base,
          rate: { newPerOld: 1, source: "simulated" },
          prices: { oldUsd: 0.0021, newUsd: 0.003, spreadPercent: 42.9, at: 0, roundTrip: { inUsd: 300, outUsd: 424.29, percent: 41.43 } },
          links: { migrate: "https://etherscan.io/address/0xabc#writeContract", website: null },
        },
      }),
      lang,
      new Date("2026-10-13T00:00:00Z"),
    );
    assert.equal(markdownV2Problem(card), null, card);
    assert.match(card, /💰/);
    assert.match(card, /\$424\\\.29 \\\(\\\+41\\\.4%\\\)/);
    assert.match(card, /🚀/);
  }
  assert.match(formatProfitAlert(migration({ detectedAt: new Date("2026-10-10T00:00:00Z") }), "ru", new Date("2026-10-13T00:00:00Z")), /через 3 дн\\\. после первого алерта/);
});
