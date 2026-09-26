import { Telegraf } from "telegraf";
import { registerAddTokenCommand } from "./commands/addToken.js";
import { registerListCommand } from "./commands/list.js";
import { registerRemoveTokenCommand } from "./commands/removeToken.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerCallbacks } from "./callbacks.js";
import { formatMigrationAlert } from "./notificationFormatter.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import type { AnalyzedMigration } from "../queue/notificationQueue.js";
import { logger } from "../utils/logger.js";

const WELCOME_TEXT = [
  "🛰 Multi-EVM Migration Tracker",
  "",
  "Watches token owners/admins across EVM networks for new contract deployments, and flags the ones that look like a migration into a new token.",
  "",
  "Commands:",
  "/add_token <network> <address> — track a token, auto-discover its owners",
  "/list — tracked tokens and their owners (paginated)",
  "/remove_token <address> — stop tracking a token (asks to confirm)",
  "/settings — toggle which confidence level / networks alert this chat",
  "/help — show this message again",
].join("\n");

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.start((ctx) => ctx.reply(WELCOME_TEXT));
  bot.help((ctx) => ctx.reply(WELCOME_TEXT));

  registerAddTokenCommand(bot);
  registerListCommand(bot);
  registerRemoveTokenCommand(bot);
  registerSettingsCommand(bot);
  registerCallbacks(bot);

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
