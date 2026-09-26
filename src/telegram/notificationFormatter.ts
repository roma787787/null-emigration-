import type { MigrationContractRecord, TokenRecord } from "../types/index.js";
import { networks } from "../config/networks.js";

function shorten(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function tokenBSourceLabel(migration: MigrationContractRecord): string {
  switch (migration.tokenBSource) {
    case "static_call":
      return migration.matchedGetter ? `переменной ${migration.matchedGetter}` : "переменной";
    case "constructor_args":
      return "конструкторе";
    case "token_a_match":
      return "конструкторе — совпадает с Token A";
    default:
      return "";
  }
}

function foundSignals(migration: MigrationContractRecord): string[] {
  const signals: string[] = [];

  for (const fn of migration.matchedFunctions) signals.push(`Функция ${fn}`);
  for (const ev of migration.matchedEvents) signals.push(`Событие ${ev}`);
  if (migration.tokenBSource === "static_call" && migration.matchedGetter) {
    signals.push(`переменная ${migration.matchedGetter}`);
  }
  for (const aux of migration.matchedAuxiliary) signals.push(`переменная ${aux}`);

  return signals;
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
    ? `${escapeMd(migration.tokenBAddress)} \\[Найден в ${escapeMd(tokenBSourceLabel(migration))}\\]`
    : "_ещё не задан_";

  const signals = foundSignals(migration);
  const signalsLine = signals.length > 0 ? signals.map(escapeMd).join(", ") : "_явных признаков не найдено_";

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
    `📊 Статус анализа: ${confidenceEmoji} *${migration.confidence} CONFIDENCE* \\(${migration.confidenceScore}%\\)`,
    `⚡️ Найдено: ${signalsLine}`,
    "",
    "🔗 Ссылки:",
    links.join(" \\| "),
  ].join("\n");
}
