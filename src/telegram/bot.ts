import { Telegraf } from "telegraf";
import { registerAddTokenCommand } from "./commands/addToken.js";
import { registerListCommand } from "./commands/list.js";
import { registerRemoveTokenCommand } from "./commands/removeToken.js";
import { registerAddOwnerCommand } from "./commands/addOwner.js";
import { registerRemoveOwnerCommand } from "./commands/removeOwner.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerCustodianCommands } from "./commands/custodians.js";
import { registerCallbacks } from "./callbacks.js";
import { registerAccessControl, isAdminChat } from "./accessControl.js";
import { formatMigrationAlert } from "./notificationFormatter.js";
import { formatListingAlert } from "./listingFormatter.js";
import type { ListingBatch } from "../rwa/listings.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import type { AnalyzedMigration } from "../queue/notificationQueue.js";
import type { OwnersRefreshed } from "../chain/ownerRefresh.js";
import { DEFAULT_LANGUAGE, t } from "./i18n/index.js";
import { formatOwnerLines } from "./views/ownerLines.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { ChatSettingsRecord, MigrationContractRecord } from "../types/index.js";
import { sendWithRetry } from "./send.js";

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  // Registered first so its gate middleware runs before every other handler.
  registerAccessControl(bot);

  registerAddTokenCommand(bot);
  registerListCommand(bot);
  registerRemoveTokenCommand(bot);
  registerAddOwnerCommand(bot);
  registerRemoveOwnerCommand(bot);
  registerSettingsCommand(bot);
  registerAnalyzeCommand(bot);
  registerStatusCommand(bot);
  registerCustodianCommands(bot);
  registerCallbacks(bot);

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, "Unhandled Telegram bot error");
  });

  return bot;
}

/**
 * Auto-discovered contracts reach a chat only if it takes them, and only when
 * OKX found an executable route for Token A within the chat's liquidity
 * level (Strict: $1,000 / 5%, Low-Cap: $300 / 10%). Custodian (RWA)
 * deployments skip the DEX test. Tracked projects are always delivered.
 */
export function wantsAutoAlert(chat: ChatSettingsRecord, migration: MigrationContractRecord): boolean {
  if (migration.discovery === "tracked") return true;
  if (!chat.autoAlerts) return false;
  if (migration.discovery === "custodian" || !env.AUTO_REQUIRE_LIQUIDITY) return true;
  return migration.liquidity?.[chat.liquidityLevel]?.status === "pass";
}

/**
 * Sends the alert card (section 4.4) to every approved chat subscribed to
 * this network at this confidence level, in that chat's chosen language.
 */
export async function broadcastMigrationAlert(bot: Telegraf, analyzed: AnalyzedMigration): Promise<void> {
  const { token, migrationContract, update } = analyzed;
  const chats = await chatSettingsRepository.listAll();

  for (const chat of chats) {
    if (!chat.approved && !isAdminChat(chat.chatId)) continue;
    if (chat.confidenceFilter === "HIGH_ONLY" && migrationContract.confidence !== "HIGH") continue;
    if (chat.networksFilter && !chat.networksFilter.includes(migrationContract.network)) continue;
    if (!wantsAutoAlert(chat, migrationContract)) continue;

    const message = formatMigrationAlert(token, migrationContract, chat.language ?? DEFAULT_LANGUAGE, { update });

    try {
      await sendWithRetry(bot, chat.chatId, message, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err, chatId: chat.chatId }, "Failed to deliver alert to chat");
    }
  }
}

/** A new RWA token (or a digest of a batch) to every approved chat that takes them on that network. */
export async function broadcastListings(bot: Telegraf, batch: ListingBatch): Promise<void> {
  const chats = await chatSettingsRepository.listAll();
  for (const chat of chats) {
    if (!chat.approved && !isAdminChat(chat.chatId)) continue;
    if (!chat.rwaListings) continue;
    if (chat.networksFilter && !chat.networksFilter.includes(batch.network)) continue;
    try {
      await sendWithRetry(bot, chat.chatId, formatListingAlert(batch, chat.language ?? DEFAULT_LANGUAGE), {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err, chatId: chat.chatId }, "Failed to deliver RWA listing to chat");
    }
  }
}

/** Tells the chat that added a token which newly discovered wallets are now watched for it. */
export async function notifyNewOwners(bot: Telegraf, { token, added }: OwnersRefreshed): Promise<void> {
  const chat = await chatSettingsRepository.ensure(token.addedByChatId);
  const lang = chat.language ?? DEFAULT_LANGUAGE;
  const text = t(lang, "owners.refreshedNew", {
    symbol: token.symbol ?? token.address,
    network: token.network,
    owners: formatOwnerLines(added, lang, "  "),
  });
  try {
    await sendWithRetry(bot, token.addedByChatId, text);
  } catch (err) {
    logger.error({ err, chatId: token.addedByChatId }, "Failed to deliver owner-refresh notice");
  }
}
