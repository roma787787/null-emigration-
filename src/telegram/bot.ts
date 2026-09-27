import { Telegraf } from "telegraf";
import { registerAddTokenCommand } from "./commands/addToken.js";
import { registerListCommand } from "./commands/list.js";
import { registerRemoveTokenCommand } from "./commands/removeToken.js";
import { registerAddOwnerCommand } from "./commands/addOwner.js";
import { registerRemoveOwnerCommand } from "./commands/removeOwner.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerCallbacks } from "./callbacks.js";
import { registerAccessControl, isAdminChat } from "./accessControl.js";
import { formatMigrationAlert } from "./notificationFormatter.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import type { AnalyzedMigration } from "../queue/notificationQueue.js";
import { DEFAULT_LANGUAGE } from "./i18n/index.js";
import { logger } from "../utils/logger.js";

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
  registerCallbacks(bot);

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, "Unhandled Telegram bot error");
  });

  return bot;
}

/**
 * Sends the alert card (section 4.4) to every approved chat subscribed to
 * this network at this confidence level, in that chat's chosen language.
 */
export async function broadcastMigrationAlert(bot: Telegraf, analyzed: AnalyzedMigration): Promise<void> {
  const { token, migrationContract } = analyzed;
  const chats = await chatSettingsRepository.listAll();

  for (const chat of chats) {
    if (!chat.approved && !isAdminChat(chat.chatId)) continue;
    if (chat.confidenceFilter === "HIGH_ONLY" && migrationContract.confidence !== "HIGH") continue;
    if (chat.networksFilter && !chat.networksFilter.includes(token.network)) continue;

    const message = formatMigrationAlert(token, migrationContract, chat.language ?? DEFAULT_LANGUAGE);

    try {
      await bot.telegram.sendMessage(chat.chatId, message, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err, chatId: chat.chatId }, "Failed to deliver alert to chat");
    }
  }
}
