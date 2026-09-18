import type { MigrationContractRecord, TokenRecord } from "../types/index.js";
import { networks } from "../config/networks.js";

function shorten(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/**
 * Renders the alert card described in spec section 4.4, using MarkdownV2.
 */
export function formatMigrationAlert(token: TokenRecord, migration: MigrationContractRecord): string {
  const network = networks[token.network];
  const symbol = token.symbol ? escapeMd(token.symbol) : "UNKNOWN";
  const tokenA = `${symbol} \\(${escapeMd(shorten(token.address))}\\)`;
  const creator = escapeMd(shorten(migration.creatorAddress));
  const contract = escapeMd(migration.contractAddress);

  const tokenBLine = migration.tokenBAddress
    ? `${escapeMd(migration.tokenBAddress)} \\[Найден\\]`
    : "_ещё не задан_";

  const functionsLine =
    migration.matchedFunctions.length > 0
      ? migration.matchedFunctions.map((f) => escapeMd(f)).join(", ")
      : "_none matched_";

  const links = [
    `[Block Explorer Contract](${network.explorerAddressUrl(migration.contractAddress)})`,
    `[Creator Explorer](${network.explorerAddressUrl(migration.creatorAddress)})`,
  ];
  if (migration.tokenBAddress) {
    links.push(`[DexScreener Token B](${network.dexscreenerTokenUrl(migration.tokenBAddress)})`);
  }

  const confidenceEmoji = migration.confidence === "HIGH" ? "🟢" : migration.confidence === "MEDIUM" ? "🟡" : "⚪️";

  return [
    "🚨 *ОБНАРУЖЕН КОНТРАКТ МИГРАЦИИ* 🚨",
    "",
    `📍 Сеть: ${escapeMd(network.label)}`,
    `🪙 Токен A: ${tokenA}`,
    `👤 Создатель: ${creator} \\(Deployer / Owner\\)`,
    "",
    "📄 Новый контракт миграции:",
    contract,
    "",
    "🎯 Целевой токен \\(Token B\\):",
    tokenBLine,
    "",
    `📊 Статус анализа: ${confidenceEmoji} *${migration.confidence} CONFIDENCE*`,
    `⚡️ Найдена функция: ${functionsLine}`,
    "",
    "🔗 Ссылки:",
    links.join(" \\| "),
  ].join("\n");
}
