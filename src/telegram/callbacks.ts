import type { Telegraf } from "telegraf";
import { getAddress } from "viem";
import { isKnownNetwork } from "../config/networks.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import { renderSettings, toggleNetworkFilter } from "./views/settingsView.js";
import { renderListPage } from "./views/listView.js";

export function registerCallbacks(bot: Telegraf): void {
  bot.action(/^settings:confidence:(ALL|HIGH_ONLY)$/, async (ctx) => {
    const filter = ctx.match[1] as "ALL" | "HIGH_ONLY";
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);

    await chatSettingsRepository.setConfidenceFilter(chatId, filter);
    const { text, keyboard } = await renderSettings(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery(`Confidence: ${filter}`);
  });

  bot.action(/^settings:net:(.+)$/, async (ctx) => {
    const value = ctx.match[1]!;
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    const settings = await chatSettingsRepository.ensure(chatId);

    if (value === "ALL") {
      await chatSettingsRepository.setNetworksFilter(chatId, null);
    } else if (isKnownNetwork(value)) {
      const next = toggleNetworkFilter(settings.networksFilter, value);
      await chatSettingsRepository.setNetworksFilter(chatId, next);
    } else {
      await ctx.answerCbQuery("Unknown network");
      return;
    }

    const { text, keyboard } = await renderSettings(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^list:page:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    const { text, keyboard } = await renderListPage(page);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^remove:confirm:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    const address = getAddress(ctx.match[1]!);
    const removedCount = await tokenRepository.removeByAddress(address);

    await ctx
      .editMessageText(
        removedCount > 0
          ? `🗑 Removed ${address} (${removedCount} network entr${removedCount === 1 ? "y" : "ies"}).`
          : `${address} was not being tracked (already removed?).`,
      )
      .catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action("remove:cancel", async (ctx) => {
    await ctx.editMessageText("Cancelled — token is still tracked.").catch(() => undefined);
    await ctx.answerCbQuery("Cancelled");
  });
}
