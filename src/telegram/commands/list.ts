import type { Telegraf } from "telegraf";
import { renderListPage } from "../views/listView.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";

export function registerListCommand(bot: Telegraf): void {
  bot.command("list", async (ctx) => {
    const settings = await chatSettingsRepository.ensure(String(ctx.chat.id));
    const { text, keyboard } = await renderListPage(0, settings.language ?? DEFAULT_LANGUAGE);
    await ctx.reply(text, keyboard);
  });
}
