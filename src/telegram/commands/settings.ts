import type { Telegraf } from "telegraf";
import { renderSettings } from "../views/settingsView.js";

export function registerSettingsCommand(bot: Telegraf): void {
  bot.command("settings", async (ctx) => {
    const { text, keyboard } = await renderSettings(String(ctx.chat.id));
    await ctx.reply(text, keyboard);
  });
}
