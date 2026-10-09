import type { Language, MigrationContractRecord, MigrationTerms, StoredLiquidityCheck, TokenRecord } from "../types/index.js";
import { getNetwork } from "../config/networks.js";
import { t } from "./i18n/index.js";

function shorten(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function tokenBSourceLabel(lang: Language, migration: MigrationContractRecord): string {
  switch (migration.tokenBSource) {
    case "static_call":
      return t(lang, "card.sourceStaticCall", { getter: migration.matchedGetter ?? "" });
    case "constructor_args":
      return t(lang, "card.sourceConstructor");
    case "contract_itself":
      return t(lang, "card.sourceSelf");
    case "bytecode":
      return t(lang, "card.sourceBytecode");
    default:
      return "";
  }
}

const MAX_FUNCTIONS_SHOWN = 3;

/**
 * Action functions (ones taking arguments, e.g. migrateFromLEND(uint256))
 * first, then zero-arg state getters like migrationEnded(); original order
 * is kept within each group.
 */
export function orderFunctionsForDisplay(functions: string[]): string[] {
  const takesArgs = (signature: string) => !signature.endsWith("()");
  return [...functions.filter(takesArgs), ...functions.filter((f) => !takesArgs(f))];
}

function foundSignals(lang: Language, migration: MigrationContractRecord): string[] {
  const signals: string[] = [];

  const functions = orderFunctionsForDisplay(migration.matchedFunctions);
  for (const fn of functions.slice(0, MAX_FUNCTIONS_SHOWN)) signals.push(`${t(lang, "card.functionWord")} ${fn}`);
  const hidden = functions.length - MAX_FUNCTIONS_SHOWN;
  if (hidden > 0) signals.push(t(lang, "card.moreFunctions", { count: String(hidden) }));
  for (const ev of migration.matchedEvents) signals.push(`${t(lang, "card.eventWord")} ${ev}`);
  if (migration.tokenBSource === "static_call" && migration.matchedGetter) {
    signals.push(`${t(lang, "card.variableWord")} ${migration.matchedGetter}`);
  }
  for (const aux of migration.matchedAuxiliary) signals.push(`${t(lang, "card.variableWord")} ${aux}`);

  return signals;
}

function formatImpact(check: StoredLiquidityCheck): string {
  const mark = check.status === "pass" ? "✅" : check.status === "skip" ? "❌" : "❔";
  const impact = check.impactPercent !== null ? `${check.impactPercent.toFixed(2)}%` : check.reason;
  return `$${check.amountUsd.toLocaleString("en-US")} → ${impact} ${mark}`;
}

/** "💧 Liquidity (OKX): $10,000 → 2.10% ✅ · $1,000 → 0.80% ✅ · $300 → 0.20% ✅" — the executable-route tests on Token A. */
function liquidityLine(lang: Language, migration: MigrationContractRecord): string | null {
  const checks = migration.liquidity;
  if (!checks) return null;
  // Largest swap first; detections stored before a level existed just lack it.
  const present = (["DEEP", "STRICT", "LOW_CAP"] as const).flatMap((level) => (checks[level] ? [checks[level]] : []));
  const label = escapeMd(t(lang, "card.liquidity"));
  if (present.every((c) => c.status === "unchecked")) {
    return `💧 ${label}: _${escapeMd(t(lang, "card.liquidityUnchecked", { reason: present[0]?.reason ?? "" }))}_`;
  }
  return `💧 ${label}: ${escapeMd(present.map(formatImpact).join(" · "))}`;
}

/** "24.09.2026 14:00 UTC" */
export function formatUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** "$0.002135", "$1.23", "$1,234" — enough digits to compare two close prices, never exponent notation. */
export function formatUsd(value: number): string {
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  const digits = Math.min(12, Math.max(4, Math.ceil(-Math.log10(value)) + 3));
  return `$${value.toFixed(digits)}`;
}

/** "1:750", "1:1.5", "1:0.64", "1,000:1" — new tokens per old one as old:new. */
export function formatRatePair(newPerOld: number): string {
  const n = (x: number) => (x >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Number(x.toPrecision(4))));
  // Below 1:0.01 the other way round reads better: 1,000:1, not 1:0.001.
  return newPerOld >= 0.01 ? `1:${n(newPerOld)}` : `${n(1 / newPerOld)}:1`;
}

/** The rate a trade is computed at: the resolved one, or 1:1 for terms stored before rates were read. */
function tradePair(terms: MigrationTerms | null | undefined): { pair: string; note: "card.spreadCheckRatio" | "card.rateUnconfirmed" | null } {
  const rate = terms?.rate;
  if (rate && rate.source !== "market") return { pair: formatRatePair(rate.newPerOld), note: rate.source === "assumed" ? "card.rateUnconfirmed" : null };
  return { pair: "1:1", note: rate === undefined && terms?.ratio ? "card.spreadCheckRatio" : null };
}

/** The 🔁 line: the rate and where it comes from. */
function rateLine(lang: Language, terms: MigrationTerms): string | null {
  const rate = terms.rate;
  const getter = terms.ratio?.getter ?? "";
  const value = terms.ratio?.value ?? "";
  let text: string;
  if (rate === undefined) {
    // Stored before rates were read: the raw value, as it was shown then.
    if (!terms.ratio) return null;
    return `🔁 ${escapeMd(t(lang, "card.ratio"))}: ${escapeMd(`${getter} = ${value}`)} _\\(${escapeMd(t(lang, "card.ratioNote"))}\\)_`;
  }
  if (rate === null) {
    text = terms.ratio ? `${getter} = ${value} (${t(lang, "card.ratioNote")})` : t(lang, "card.rateUnknown");
  } else {
    const pair = formatRatePair(rate.newPerOld);
    text =
      rate.source === "simulated" ? t(lang, "card.rateSimulated", { pair })
      : rate.source === "ratio" ? t(lang, rate.checked ? "card.rateChecked" : "card.rateUnchecked", { pair, getter, value })
      : rate.source === "assumed" ? t(lang, "card.rateAssumed")
      : t(lang, terms.ratio ? "card.rateMarketRaw" : "card.rateMarket", { pair, getter, value });
  }
  return `🔁 ${escapeMd(t(lang, "card.ratio"))}: ${escapeMd(text)}`;
}

export function formatSpread(percent: number): string {
  return `${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%`;
}

/** The "💱 Prices: old $0.0021 · new $0.0022 · spread +4.8% at 1:1" line (the spread at the rate), or null without a single price. */
export function pricesLine(lang: Language, terms: MigrationTerms | null | undefined): string | null {
  const prices = terms?.prices;
  if (!prices) return null;
  const price = (v: number | null, thin?: boolean) =>
    v === null ? t(lang, "card.noMarket") : formatUsd(v) + (thin ? ` (${t(lang, "card.thinMarket")})` : "");
  const parts = [
    `${t(lang, "card.priceOld")} ${price(prices.oldUsd, prices.oldThin)}`,
    `${t(lang, "card.priceNew")} ${price(prices.newUsd, prices.newThin)}`,
  ];
  // With the trade quoted both ways, the round trip replaces the spread of two prices.
  if (prices.spreadPercent !== null && !prices.roundTrip) {
    const { pair, note } = tradePair(terms);
    parts.push(t(lang, "card.spread", { spread: formatSpread(prices.spreadPercent), pair }) + (note ? ` (${t(lang, note)})` : ""));
  }
  return `💱 ${escapeMd(t(lang, "card.prices"))}: ${escapeMd(parts.join(" · "))}`;
}

/** Status, deadline, ratio and funding lines — what the contract says about acting on it. */
export function termsLines(lang: Language, terms: MigrationTerms | null | undefined): string[] {
  if (!terms) return [];
  const lines: string[] = [];
  const status =
    terms.status === "open" ? t(lang, "card.statusOpen")
    : terms.status === "paused" ? t(lang, "card.statusPaused")
    : terms.status === "ended" ? t(lang, "card.statusEnded")
    : terms.status === "not_started"
      ? terms.startsAt !== null ? t(lang, "card.statusNotStartedAt", { date: formatUtc(terms.startsAt) }) : t(lang, "card.statusNotStarted")
      : t(lang, "card.statusUnknown");
  lines.push(`⏳ ${escapeMd(t(lang, "card.statusLabel"))}: ${escapeMd(status)}`);
  if (terms.endsAt !== null) lines.push(`📅 ${escapeMd(t(lang, "card.deadline"))}: ${escapeMd(formatUtc(terms.endsAt))}`);
  const rate = rateLine(lang, terms);
  if (rate) lines.push(rate);
  if (terms.funding) {
    const funding =
      terms.funding.kind === "mint" ? t(lang, "card.fundingMint")
      : terms.funding.empty ? t(lang, "card.fundingEmpty")
      : t(lang, "card.fundingBalance", { amount: terms.funding.amount, symbol: terms.funding.symbol ?? "" }).replace(/\s{2,}/g, " ");
    lines.push(`🏦 ${escapeMd(t(lang, "card.funding"))}: ${escapeMd(funding)}`);
  }
  const prices = pricesLine(lang, terms);
  if (prices) lines.push(prices);
  const trip = terms.prices?.roundTrip;
  if (trip) {
    const { pair, note } = tradePair(terms);
    const text =
      trip.outUsd === null || trip.percent === null
        ? t(lang, "card.roundTripNoRoute", { in: formatUsd(trip.inUsd), pair })
        : t(lang, "card.roundTrip", { in: formatUsd(trip.inUsd), out: formatUsd(trip.outUsd), pct: formatSpread(trip.percent), pair });
    lines.push(`🔄 ${escapeMd(text)}${note ? ` _\\(${escapeMd(t(lang, note))}\\)_` : ""}`);
  }
  return lines;
}

interface FormatOptions {
  /** An on-demand /analyze result rather than a live detection: neutral title, no owner claim about the creator. */
  manual?: boolean;
  /** A re-check found more (usually Token B) after the first alert for this contract. */
  update?: boolean;
}

/**
 * Renders the alert card described in spec section 4.4, using MarkdownV2, in
 * the receiving chat's chosen language. `token` is null when /analyze was run
 * without a known Token A.
 */
export function formatMigrationAlert(
  token: TokenRecord | null,
  migration: MigrationContractRecord,
  lang: Language,
  options: FormatOptions = {},
): string {
  const network = getNetwork(migration.network);
  // Token A is identified by its full address: tickers repeat across networks.
  const tokenAAddress = token?.address ?? migration.tokenAAddress;
  const tokenASymbol = token?.symbol ?? migration.tokenASymbol;
  const tokenA = tokenAAddress
    ? `${escapeMd(tokenASymbol ?? "UNKNOWN")} · ${escapeMd(tokenAAddress)}`
    : `_${escapeMd(t(lang, "card.tokenAUnknown"))}_`;
  const creator = escapeMd(shorten(migration.creatorAddress));
  const contract = escapeMd(migration.contractAddress);

  const tokenBLine = migration.tokenBAddress
    ? `${escapeMd(migration.tokenBAddress)} \\[${escapeMd(t(lang, "card.foundIn"))} ${escapeMd(tokenBSourceLabel(lang, migration))}\\]`
    : migration.tokenBSymbolUnverified
      ? `⚠️ *Unverified*: ${escapeMd(migration.tokenBSymbolUnverified)} \\(${escapeMd(t(lang, "card.unverifiedNote"))}\\)`
      : migration.tokenBSource === "token_a_match"
      ? `_${escapeMd(t(lang, "card.notSetYet"))}_ \\(${escapeMd(t(lang, "card.tokenARefNote"))}\\)`
      : `_${escapeMd(t(lang, "card.notSetYet"))}_`;

  const signals = foundSignals(lang, migration);
  const signalsLine = signals.length > 0 ? signals.map(escapeMd).join(", ") : `_${escapeMd(t(lang, "card.noSignals"))}_`;

  const links = [
    `[Block Explorer Contract](${network.explorerAddressUrl(migration.contractAddress)})`,
    `[Creator Explorer](${network.explorerAddressUrl(migration.creatorAddress)})`,
  ];
  if (tokenAAddress && migration.discovery !== "tracked") {
    links.push(`[DexScreener Token A](${network.dexscreenerTokenUrl(tokenAAddress)})`);
  }
  if (migration.tokenBAddress) {
    links.push(`[DexScreener Token B](${network.dexscreenerTokenUrl(migration.tokenBAddress)})`);
  }

  const confidenceEmoji = migration.confidence === "HIGH" ? "🟢" : migration.confidence === "MEDIUM" ? "🟡" : "⚪️";

  const title = options.manual
    ? `🔎 *${escapeMd(t(lang, "card.titleManual"))}*`
    : options.update
      ? `🔄 *${escapeMd(t(lang, "card.titleUpdate"))}*\n_${escapeMd(t(lang, "card.updateNote"))}_`
      : `🚨 *${escapeMd(t(lang, "card.title"))}* 🚨`;
  const creatorRole = options.manual
    ? ""
    : migration.discovery === "custodian"
      ? ` \\(${escapeMd(migration.custodianLabel ?? "custodian")}\\)`
      : migration.discovery === "tracked"
        ? ` \\(${escapeMd(t(lang, "card.deployerOwner"))}\\)`
        : "";
  const source =
    migration.discovery === "auto"
      ? `🛰 _${escapeMd(t(lang, "card.sourceAuto"))}_`
      : migration.discovery === "custodian"
        ? `🏦 _${escapeMd(t(lang, "card.sourceCustodian", { label: migration.custodianLabel ?? "" }))}_`
        : null;
  const extras: string[] = [];
  const liquidity = liquidityLine(lang, migration);
  if (liquidity) extras.push(liquidity);
  if (migration.rwaSignals.length > 0) extras.push(`🏦 RWA: ${escapeMd(migration.rwaSignals.join(", "))}`);
  const terms = termsLines(lang, migration.terms);
  if (terms.length > 0) extras.push("", ...terms);

  return [
    title,
    ...(source ? [source] : []),
    "",
    `📍 ${escapeMd(t(lang, "card.network"))}: ${escapeMd(network.label)}`,
    `🪙 ${escapeMd(t(lang, "card.tokenA"))}: ${tokenA}`,
    `👤 ${escapeMd(t(lang, "card.creator"))}: ${creator}${creatorRole}`,
    "",
    `📄 ${escapeMd(t(lang, options.manual || options.update ? "card.contract" : "card.newContract"))}`,
    contract,
    "",
    `🎯 ${escapeMd(t(lang, "card.targetToken"))}`,
    tokenBLine,
    "",
    `📊 ${escapeMd(t(lang, "card.analysisStatus"))}: ${confidenceEmoji} *${migration.confidence} ${escapeMd(t(lang, "card.confidenceWord"))}* \\(${migration.confidenceScore}%\\)`,
    `⚡️ ${escapeMd(t(lang, "card.foundSignals"))}: ${signalsLine}`,
    ...extras,
    "",
    `🔗 ${escapeMd(t(lang, "card.links"))}`,
    links.join(" \\| "),
  ].join("\n");
}

/**
 * The second card: the first exchange went through the contract. Tokens,
 * the transaction, how long after the first alert, and fresh prices/spread.
 */
export function formatMigrationOpened(migration: MigrationContractRecord, lang: Language, now = new Date()): string {
  const network = getNetwork(migration.network);
  const tokenA = migration.tokenAAddress
    ? `${escapeMd(migration.tokenASymbol ?? "UNKNOWN")} · ${escapeMd(migration.tokenAAddress)}`
    : `_${escapeMd(t(lang, "card.tokenAUnknown"))}_`;
  const tokenB = migration.tokenBAddress
    ? escapeMd(migration.tokenBAddress)
    : migration.tokenBSymbolUnverified
      ? `⚠️ *Unverified*: ${escapeMd(migration.tokenBSymbolUnverified)}`
      : `_${escapeMd(t(lang, "card.notSetYet"))}_`;
  const minutes = Math.max(0, Math.round((now.getTime() - migration.detectedAt.getTime()) / 60_000));
  const hours = Math.round(minutes / 60);
  const after =
    hours >= 48 ? t(lang, "opened.after", { days: String(Math.round(hours / 24)) })
    : minutes >= 60 ? t(lang, "opened.afterHours", { hours: String(hours) })
    : t(lang, "opened.afterMinutes", { minutes: String(minutes) });
  const tx = migration.openedTx
    ? `[${escapeMd(shorten(migration.openedTx))}](${network.explorerTxUrl(migration.openedTx)}) · ${escapeMd(after)}`
    : escapeMd(after);

  const links = [`[Block Explorer Contract](${network.explorerAddressUrl(migration.contractAddress)})`];
  if (migration.tokenAAddress) links.push(`[DexScreener Token A](${network.dexscreenerTokenUrl(migration.tokenAAddress)})`);
  if (migration.tokenBAddress) links.push(`[DexScreener Token B](${network.dexscreenerTokenUrl(migration.tokenBAddress)})`);

  const terms = migration.terms ? termsLines(lang, { ...migration.terms, status: "open" }).slice(1) : [];

  return [
    `🟢 *${escapeMd(t(lang, "opened.title"))}* 🟢`,
    `_${escapeMd(t(lang, "opened.note"))}_`,
    "",
    `📍 ${escapeMd(t(lang, "card.network"))}: ${escapeMd(network.label)}`,
    `🪙 ${escapeMd(t(lang, "card.tokenA"))}: ${tokenA}`,
    `🎯 ${escapeMd(t(lang, "card.targetToken"))} ${tokenB}`,
    `📄 ${escapeMd(t(lang, "card.contract"))} ${escapeMd(migration.contractAddress)}`,
    `🧾 ${escapeMd(t(lang, "opened.firstTx"))}: ${tx}`,
    ...(terms.length > 0 ? ["", ...terms] : []),
    "",
    `🔗 ${escapeMd(t(lang, "card.links"))}`,
    links.join(" \\| "),
  ].join("\n");
}
