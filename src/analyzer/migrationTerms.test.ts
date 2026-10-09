import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, migratedAmount, priceFromCheck, priceFromQuote, resolveRate, spreadPercent } from "./migrationTerms.js";
import { exchangeCalls, fillCall, interpretRatio, newPerOldFromRaw, PROBE_ADDRESS } from "./migrationRate.js";
import { decodeAbiParameters } from "viem";
import { formatRatePair } from "../telegram/notificationFormatter.js";
import { toFunctionSelector, type Hex } from "viem";
import { formatSpread, formatUsd, formatUtc, termsLines } from "../telegram/notificationFormatter.js";
import { markdownV2Problem } from "../telegram/markdownV2.js";
import type { MigrationTerms } from "../types/index.js";

const check = (amountOut: string) =>
  ({ status: "pass", level: "LOW_CAP", amountUsd: 300, maxImpactPercent: 10, impactPercent: 0.3, reason: "", amountOut }) as const;

test("price per whole token from a $300 test swap, and the spread at 1:1", () => {
  // $300 bought 142,857.14 tokens (18 decimals) → $0.0021 each
  assert.ok(Math.abs(priceFromCheck(check("142857142857142857142857"), 18)! - 0.0021) < 1e-9);
  // 2-decimal token (old TEL): $300 bought 1,500.00 → $0.20
  assert.equal(priceFromCheck(check("150000"), 2), 0.2);
  assert.equal(priceFromCheck({ ...check("1"), status: "skip" }, 18), null);
  assert.equal(priceFromCheck(check("1000"), null), null);
  assert.ok(Math.abs(spreadPercent(0.0021, 0.0022)! - 4.7619) < 1e-3);
  // $20 small quote bought 10,000 tokens → $0.002
  assert.equal(priceFromQuote({ amountUsd: 20, amountOut: (10_000n * 10n ** 18n).toString(), impactPercent: 12 }, 18), 0.002);
  assert.equal(priceFromQuote(null, 18), null);
  assert.equal(spreadPercent(null, 0.0022), null);
});

test("amounts, prices, spreads and dates are written for people", () => {
  assert.equal(formatAmount(10n ** 24n, 18), "1,000,000");
  assert.equal(formatAmount(1234567n * 10n ** 16n, 18), "12,345.67");
  assert.equal(formatAmount(0n, 18), "0");
  assert.equal(formatUsd(0.0021), "$0.002100");
  assert.equal(formatUsd(0.00000123), "$0.000001230");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(43210.4), "$43,210");
  assert.equal(formatSpread(4.7619), "+4.8%");
  assert.equal(formatSpread(-2.04), "−2.0%");
  assert.equal(formatUtc(1790251200), "24.09.2026 12:00 UTC");
});

test("terms lines are valid MarkdownV2 in every shape", () => {
  const base: MigrationTerms = { status: "unknown", startsAt: null, endsAt: null, ratio: null, funding: null, prices: null };
  const shapes: MigrationTerms[] = [
    base,
    { ...base, status: "not_started", startsAt: 1790251200, endsAt: 1821787200 },
    { ...base, status: "open", ratio: { getter: "LEND_AAVE_RATIO()", value: "100" }, funding: { kind: "mint" } },
    { ...base, status: "paused", funding: { kind: "balance", amount: "1,000,000.50", empty: false, symbol: "NEW" } },
    { ...base, status: "ended", funding: { kind: "balance", amount: "0", empty: true, symbol: null } },
    { ...base, prices: { oldUsd: 0.0021, newUsd: 0.0022, spreadPercent: 4.76, at: 0 } },
    { ...base, prices: { oldUsd: 0.0021, newUsd: 0.0022, spreadPercent: 4.76, at: 0, newThin: true } },
    { ...base, ratio: { getter: "rate()", value: "1" }, prices: { oldUsd: 1.5, newUsd: null, spreadPercent: null, at: 0 } },
    { ...base, prices: { oldUsd: 0.0021, newUsd: 0.0022, spreadPercent: 4.76, at: 0, newThin: true, roundTrip: { inUsd: 300, outUsd: 276.57, percent: -7.81 } } },
    { ...base, ratio: { getter: "rate()", value: "2" }, prices: { oldUsd: 0.0021, newUsd: 0.0022, spreadPercent: 4.76, at: 0, roundTrip: { inUsd: 300, outUsd: null, percent: null } } },
    { ...base, ratio: { getter: "SWAP_RATIO()", value: "750" }, rate: { newPerOld: 750, source: "ratio", checked: true }, prices: { oldUsd: 12.25, newUsd: 0.01064, spreadPercent: -34.9, at: 0, roundTrip: { inUsd: 300, outUsd: 195.4, percent: -34.87 } } },
    { ...base, rate: { newPerOld: 1000, source: "simulated" }, prices: { oldUsd: 12.25, newUsd: 0.01064, spreadPercent: -13.1, at: 0 } },
    { ...base, rate: { newPerOld: 1151.3, source: "market" }, prices: { oldUsd: 12.25, newUsd: 0.01064, spreadPercent: null, at: 0 } },
    { ...base, ratio: { getter: "rate()", value: "3" }, rate: { newPerOld: 1151.3, source: "market" }, prices: { oldUsd: 12.25, newUsd: 0.01064, spreadPercent: null, at: 0 } },
    { ...base, ratio: { getter: "rate()", value: "750" }, rate: { newPerOld: 750, source: "ratio", checked: false }, prices: null },
    { ...base, rate: { newPerOld: 1, source: "assumed" }, prices: null },
    { ...base, rate: { newPerOld: 1, source: "assumed" }, prices: { oldUsd: 0.1042, newUsd: 0.1622, spreadPercent: 55.7, at: 0, roundTrip: { inUsd: 300, outUsd: 458.22, percent: 52.74 } } },
    { ...base, rate: null, prices: { oldUsd: 0.02845, newUsd: null, spreadPercent: null, at: 0 } },
  ];
  for (const lang of ["en", "uk", "ru"] as const) {
    for (const terms of shapes) {
      const text = termsLines(lang, terms).join("\n");
      assert.equal(markdownV2Problem(text), null, `${lang}: ${text}`);
    }
  }
  assert.match(termsLines("en", shapes[1]!).join("\n"), /opens 24\\\.09\\\.2026 12:00 UTC/);
  assert.match(termsLines("ru", shapes[5]!).join("\n"), /старый \$0\\\.002100 · новый \$0\\\.002200 · разница \\\+4\\\.8% при 1:1/);
  assert.match(termsLines("en", shapes[6]!).join("\n"), /new \$0\\\.002200 \\\(thin market\\\)/);
  // With the trade quoted both ways, the bare spread of two prices gives way to it.
  const traded = termsLines("ru", shapes[8]!).join("\n");
  assert.doesNotMatch(traded, /разница/);
  assert.match(traded, /🔄 Сделка на \$300\\\.00: .* \\= \$276\\\.57 \\\(−7\\\.8%\\\)/);
  assert.match(termsLines("en", shapes[9]!).join("\n"), /🔄 Trade \$300\\\.00: .*no route now/);
  const quick = termsLines("ru", shapes[10]!).join("\n");
  assert.match(quick, /🔁 Курс \\\(старый:новый\\\): 1:750 — из SWAP\\_RATIO\\\(\\\) \\= 750, цены сходятся/);
  assert.match(quick, /мигрировать 1:750 → продать новый \\= \$195\\\.40 \\\(−34\\\.9%\\\)/);
  assert.doesNotMatch(quick, /сверьте/);
  assert.match(termsLines("en", shapes[11]!).join("\n"), /1:1,000 — checked by a trial exchange on the contract/);
  assert.match(termsLines("en", shapes[11]!).join("\n"), /spread −13\\\.1% at 1:1,000/);
  assert.match(termsLines("en", shapes[12]!).join("\n"), /not stated in the contract; by prices ≈ 1:1,151/);
  assert.match(termsLines("en", shapes[13]!).join("\n"), /rate\\\(\\\) \\= 3 doesn't match prices/);
  assert.match(termsLines("en", shapes[14]!).join("\n"), /1:750 — from rate\\\(\\\) \\= 750, read as a multiplier/);
  assert.match(termsLines("ru", shapes[15]!).join("\n"), /1:1 НЕ подтверждён — в контракте курса нет, пробный обмен не прошёл/);
  // PHAR → p33: no rate anywhere, prices 1.56× apart — the trade at 1:1 is marked unconfirmed.
  const phar = termsLines("en", shapes[16]!).join("\n");
  assert.match(phar, /migrate 1:1 → sell new \\= \$458\\\.22 \\\(\\\+52\\\.7%\\\) _\\\(1:1 not confirmed\\\)_/);
  assert.match(termsLines("ru", shapes[17]!).join("\n"), /🔁 Курс \\\(старый:новый\\\): неизвестен — в контракте не указан, пробный обмен не прошёл/);
  assert.deepEqual(termsLines("en", null), []);
});

test("old tokens become new ones at the rate, across decimals", () => {
  assert.equal(migratedAmount(5n * 10n ** 18n, 18, 18), 5n * 10n ** 18n);
  assert.equal(migratedAmount(5n * 10n ** 18n, 18, 6), 5_000_000n);
  assert.equal(migratedAmount(5_000_000n, 6, 18), 5n * 10n ** 18n);
  assert.equal(migratedAmount(24n * 10n ** 18n, 18, 18, 1000), 24_000n * 10n ** 18n);
  assert.equal(migratedAmount(10n ** 18n, 18, 18, 0.25), 25n * 10n ** 16n);
});

test("the spread is taken at the rate", () => {
  // QUICK: old $12.25, new $0.01064, 1:1000 → each old token fetches $10.64.
  assert.ok(Math.abs(spreadPercent(12.25, 0.01064, 1000)! - -13.14) < 0.01);
});

test("a ratio getter is read the way the market agrees with", () => {
  // SWAP_RATIO() = 750, old $12.25 vs new $0.01064 (market ≈ 1:1151) → × 750, confirmed.
  assert.deepEqual(interpretRatio(750n, 18, 18, 12.25 / 0.01064), { newPerOld: 750, checked: true });
  // The same 750 with prices saying 1 new is worth 750 old → ÷ 750.
  assert.ok(Math.abs(interpretRatio(750n, 18, 18, 1 / 700)!.newPerOld - 1 / 750) < 1e-12);
  // 1e18-scaled 1:1 and basis points.
  assert.equal(interpretRatio(10n ** 18n, 18, 18, 1.1)!.newPerOld, 1);
  assert.equal(interpretRatio(5000n, 18, 18, 0.52)!.newPerOld, 0.5);
  // Prices nowhere near any reading: not trusted.
  assert.equal(interpretRatio(750n, 18, 18, 3), null);
  // No prices: × r, or r / 1e18 when it is that large — unchecked.
  assert.deepEqual(interpretRatio(750n, 18, 18, null), { newPerOld: 750, checked: false });
  assert.deepEqual(interpretRatio(2n * 10n ** 18n, 18, 18, null), { newPerOld: 2, checked: false });
});

test("the rate: simulated first, then the ratio getter, then prices", () => {
  const prices = { oldUsd: 12.25, newUsd: 0.01064 };
  const ratio = { getter: "SWAP_RATIO()", value: "750" };
  assert.deepEqual(resolveRate({ received: 1000n * 10n ** 18n, spent: 10n ** 18n }, ratio, 18, 18, prices), { newPerOld: 1000, source: "simulated" });
  assert.deepEqual(resolveRate(null, ratio, 18, 18, prices), { newPerOld: 750, source: "ratio", checked: true });
  assert.equal(resolveRate(null, null, 18, 18, prices)!.source, "market");
  assert.ok(Math.abs(resolveRate(null, null, 18, 18, prices)!.newPerOld - 1151.3) < 0.1);
  assert.deepEqual(resolveRate(null, null, 18, 18, { oldUsd: 0.0019, newUsd: 0.0027 }), { newPerOld: 1, source: "assumed" });
  assert.equal(resolveRate(null, null, 18, 18, { oldUsd: 1.5, newUsd: null }), null);
  assert.equal(newPerOldFromRaw(750_000_000n, 10n ** 18n, 18, 6), 750);
});

test("rates are written old:new", () => {
  assert.equal(formatRatePair(1), "1:1");
  assert.equal(formatRatePair(750), "1:750");
  assert.equal(formatRatePair(1151.3), "1:1,151");
  assert.equal(formatRatePair(1.5), "1:1.5");
  assert.equal(formatRatePair(0.64), "1:0.64");
  assert.equal(formatRatePair(0.001), "1,000:1");
});

test("the exchange is tried through the contract's migration functions only", () => {
  const sigs = ["quickToQuickX(uint256)", "SWAP_RATIO()", "quickX()", "migrate(address,uint256)", "setPaused(bool)", "migratedAmount(address)"];
  const signatures = new Map(sigs.map((s) => [toFunctionSelector(s) as string, s]));
  const selectors = [...signatures.keys()] as Hex[];
  const tokenA = "0x831753dd7087cac61ab5644b308642cc1c33dc13";
  const calls = exchangeCalls(signatures, selectors, tokenA, 5n);
  assert.equal(calls.length, 3);
  assert.ok(calls[0]!.startsWith(toFunctionSelector("quickToQuickX(uint256)")));
  assert.ok(calls.some((c) => c.includes(PROBE_ADDRESS.slice(2).toLowerCase())));
  assert.ok(calls.some((c) => c.includes(tokenA.slice(2))));
});

test("trial-exchange arguments are filled the way a holder would", () => {
  const tokenA = "0x13a466998ce03db73abc2d4df3bbd845ed1f28e7";
  const sel = (sig: string) => toFunctionSelector(sig) as Hex;
  // PHAR's convertir(amount, to, data): amount, the probe as recipient, empty bytes — and once with Token A.
  const convertir = fillCall(sel("convertir(uint256,address,bytes)"), "convertir(uint256,address,bytes)", tokenA, 7n)!;
  assert.equal(convertir.length, 2);
  const [amount, to, data] = decodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes" }], `0x${convertir[0]!.slice(10)}`);
  assert.equal(amount, 7n);
  assert.equal(to.toLowerCase(), PROBE_ADDRESS.toLowerCase());
  assert.equal(data, "0x");
  // A floor/deadline argument after the amount: tried as 0 and as a far deadline.
  const floor = fillCall(sel("convertirSousPlancher(uint256,address,bytes,uint256)"), "convertirSousPlancher(uint256,address,bytes,uint256)", tokenA, 7n)!;
  assert.equal(floor.length, 3);
  assert.equal(fillCall(sel("batch(address[])"), "batch(address[])", tokenA, 7n), null);
  // CPOOL's swap(uint256) is tried; a bare swap() or setter is not.
  const sigs = ["swap(uint256)", "swap()", "setFee(uint256)", "convertir(uint256,address,bytes)"];
  const signatures = new Map(sigs.map((s) => [toFunctionSelector(s) as string, s]));
  const calls = exchangeCalls(signatures, [...signatures.keys()] as Hex[], tokenA, 7n);
  assert.equal(calls.length, 3);
  assert.ok(calls[0]!.startsWith(sel("swap(uint256)")));
});
