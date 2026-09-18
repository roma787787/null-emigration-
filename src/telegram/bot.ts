import { Telegraf } from "telegraf";
import { registerAddTokenCommand } from "./commands/addToken.js";
import { registerListCommand } from "./commands/list.js";
import { registerRemoveTokenCommand } from "./commands/removeToken.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { formatMigrationAlert } from "./notificationFormatter.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import type { AnalyzedMigration } from "../queue/notificationQueue.js";
import { logger } from "../utils/logger.js";

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.start((ctx) => ctx.reply("Multi-EVM migration tracker online. Use /add_token <network> <address> to begin."));

  registerAddTokenCommand(bot);
  registerListCommand(bot);
  registerRemoveTokenCommand(bot);
  registerSettingsCommand(bot);

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, "Unhandled Telegram bot error");
  });

  return bot;
}

/**
 * Sends the alert card (section 4.4) to every chat subscribed to this
 * network at this confidence level or lower filtering requirements.
 */
export async function broadcastMigrationAlert(bot: Telegraf, analyzed: AnalyzedMigration): Promise<void> {
  const { token, migrationContract } = analyzed;
  const chats = await chatSettingsRepository.listAll();
  const message = formatMigrationAlert(token, migrationContract);

  for (const chat of chats) {
    if (chat.confidenceFilter === "HIGH_ONLY" && migrationContract.confidence !== "HIGH") continue;
    if (chat.networksFilter && !chat.networksFilter.includes(token.network)) continue;

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
