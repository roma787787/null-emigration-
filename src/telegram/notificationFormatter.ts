import type { Language, MigrationContractRecord, TokenRecord } from "../types/index.js";
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
  const tokenA = token
    ? `${token.symbol ? escapeMd(token.symbol) : "UNKNOWN"} \\(${escapeMd(shorten(token.address))}\\)`
    : `_${escapeMd(t(lang, "card.tokenAUnknown"))}_`;
  const creator = escapeMd(shorten(migration.creatorAddress));
  const contract = escapeMd(migration.contractAddress);

  const tokenBLine = migration.tokenBAddress
    ? `${escapeMd(migration.tokenBAddress)} \\[${escapeMd(t(lang, "card.foundIn"))} ${escapeMd(tokenBSourceLabel(lang, migration))}\\]`
    : migration.tokenBSource === "token_a_match"
      ? `_${escapeMd(t(lang, "card.notSetYet"))}_ \\(${escapeMd(t(lang, "card.tokenARefNote"))}\\)`
      : `_${escapeMd(t(lang, "card.notSetYet"))}_`;

  const signals = foundSignals(lang, migration);
  const signalsLine = signals.length > 0 ? signals.map(escapeMd).join(", ") : `_${escapeMd(t(lang, "card.noSignals"))}_`;

  const links = [
    `[Block Explorer Contract](${network.explorerAddressUrl(migration.contractAddress)})`,
    `[Creator Explorer](${network.explorerAddressUrl(migration.creatorAddress)})`,
  ];
  if (migration.tokenBAddress) {
    links.push(`[DexScreener Token B](${network.dexscreenerTokenUrl(migration.tokenBAddress)})`);
  }

  const confidenceEmoji = migration.confidence === "HIGH" ? "🟢" : migration.confidence === "MEDIUM" ? "🟡" : "⚪️";

  const title = options.manual
    ? `🔎 *${escapeMd(t(lang, "card.titleManual"))}*`
    : options.update
      ? `🔄 *${escapeMd(t(lang, "card.titleUpdate"))}*\n_${escapeMd(t(lang, "card.updateNote"))}_`
      : `🚨 *${escapeMd(t(lang, "card.title"))}* 🚨`;
  const creatorRole = options.manual ? "" : ` \\(${escapeMd(t(lang, "card.deployerOwner"))}\\)`;

  return [
    title,
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
    "",
    `🔗 ${escapeMd(t(lang, "card.links"))}`,
    links.join(" \\| "),
  ].join("\n");
}
