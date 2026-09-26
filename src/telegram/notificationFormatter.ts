import type { Language, MigrationContractRecord, TokenRecord } from "../types/index.js";
import { networks } from "../config/networks.js";
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

function foundSignals(lang: Language, migration: MigrationContractRecord): string[] {
  const signals: string[] = [];

  for (const fn of migration.matchedFunctions) signals.push(`${t(lang, "card.functionWord")} ${fn}`);
  for (const ev of migration.matchedEvents) signals.push(`${t(lang, "card.eventWord")} ${ev}`);
  if (migration.tokenBSource === "static_call" && migration.matchedGetter) {
    signals.push(`${t(lang, "card.variableWord")} ${migration.matchedGetter}`);
  }
  for (const aux of migration.matchedAuxiliary) signals.push(`${t(lang, "card.variableWord")} ${aux}`);

  return signals;
}

/**
 * Renders the alert card described in spec section 4.4, using MarkdownV2, in
 * the receiving chat's chosen language.
 */
export function formatMigrationAlert(token: TokenRecord, migration: MigrationContractRecord, lang: Language): string {
  const network = networks[token.network];
  const symbol = token.symbol ? escapeMd(token.symbol) : "UNKNOWN";
  const tokenA = `${symbol} \\(${escapeMd(shorten(token.address))}\\)`;
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

  return [
    `🚨 *${escapeMd(t(lang, "card.title"))}* 🚨`,
    "",
    `📍 ${escapeMd(t(lang, "card.network"))}: ${escapeMd(network.label)}`,
    `🪙 ${escapeMd(t(lang, "card.tokenA"))}: ${tokenA}`,
    `👤 ${escapeMd(t(lang, "card.creator"))}: ${creator} \\(${escapeMd(t(lang, "card.deployerOwner"))}\\)`,
    "",
    `📄 ${escapeMd(t(lang, "card.newContract"))}`,
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
