import type { Language, MigrationContractRecord, StoredLiquidityCheck, TokenRecord } from "../types/index.js";
import { getNetwork } from "../config/networks.js";
import { t } from "./i18n/index.js";

function shorten(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function escapeMd(text: string): string {
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

/** "💧 Liquidity (OKX): $1,000 → 0.80% ✅ · $300 → 0.20% ✅" — the executable-route test on Token A. */
function liquidityLine(lang: Language, migration: MigrationContractRecord): string | null {
  const checks = migration.liquidity;
  if (!checks) return null;
  const label = escapeMd(t(lang, "card.liquidity"));
  if (checks.STRICT.status === "unchecked" && checks.LOW_CAP.status === "unchecked") {
    return `💧 ${label}: _${escapeMd(t(lang, "card.liquidityUnchecked", { reason: checks.LOW_CAP.reason }))}_`;
  }
  return `💧 ${label}: ${escapeMd(`${formatImpact(checks.STRICT)} · ${formatImpact(checks.LOW_CAP)}`)}`;
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
