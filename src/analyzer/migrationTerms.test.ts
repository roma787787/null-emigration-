import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, priceFromCheck, priceFromQuote, spreadPercent } from "./migrationTerms.js";
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
  assert.deepEqual(termsLines("en", null), []);
});
