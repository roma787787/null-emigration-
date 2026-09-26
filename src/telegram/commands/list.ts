import type { Telegraf } from "telegraf";
import { renderListPage } from "../views/listView.js";

export function registerListCommand(bot: Telegraf): void {
  bot.command("list", async (ctx) => {
    const { text, keyboard } = await renderListPage(0);
    await ctx.reply(text, keyboard);
  });
}
