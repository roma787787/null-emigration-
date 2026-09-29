import type { Telegraf } from "telegraf";
import { getAddress } from "viem";
import { isKnownNetwork } from "../config/networks.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import { renderSettings, toggleNetworkFilter } from "./views/settingsView.js";
import { renderListPage } from "./views/listView.js";
import { t, DEFAULT_LANGUAGE } from "./i18n/index.js";

export function registerCallbacks(bot: Telegraf): void {
  bot.action(/^settings:confidence:(ALL|HIGH_ONLY)$/, async (ctx) => {
    const filter = ctx.match[1] as "ALL" | "HIGH_ONLY";
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);

    await chatSettingsRepository.setConfidenceFilter(chatId, filter);
    const { text, keyboard } = await renderSettings(chatId);
    const settings = await chatSettingsRepository.ensure(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery(t(settings.language ?? DEFAULT_LANGUAGE, "settings.cbConfidenceSet", { filter }));
  });

  bot.action(/^settings:liq:(STRICT|LOW_CAP|DEEP)$/, async (ctx) => {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    await chatSettingsRepository.setLiquidityLevel(chatId, ctx.match[1] as "STRICT" | "LOW_CAP" | "DEEP");
    const { text, keyboard } = await renderSettings(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^settings:auto:(on|off)$/, async (ctx) => {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    await chatSettingsRepository.setAutoAlerts(chatId, ctx.match[1] === "on");
    const { text, keyboard } = await renderSettings(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^settings:rwa:(on|off)$/, async (ctx) => {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    await chatSettingsRepository.setRwaListings(chatId, ctx.match[1] === "on");
    const { text, keyboard } = await renderSettings(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^settings:net:(.+)$/, async (ctx) => {
    const value = ctx.match[1]!;
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    const settings = await chatSettingsRepository.ensure(chatId);
    const lang = settings.language ?? DEFAULT_LANGUAGE;

    if (value === "ALL") {
      await chatSettingsRepository.setNetworksFilter(chatId, null);
    } else if (isKnownNetwork(value)) {
      const next = toggleNetworkFilter(settings.networksFilter, value);
      await chatSettingsRepository.setNetworksFilter(chatId, next);
    } else {
      await ctx.answerCbQuery(t(lang, "settings.cbUnknownNetwork"));
      return;
    }

    const { text, keyboard } = await renderSettings(chatId);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^list:page:(\d+)$/, async (ctx) => {
    const page = Number(ctx.match[1]);
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    const settings = await chatSettingsRepository.ensure(chatId);
    const { text, keyboard } = await renderListPage(page, settings.language ?? DEFAULT_LANGUAGE);
    await ctx.editMessageText(text, keyboard).catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action(/^remove:confirm:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    const address = getAddress(ctx.match[1]!);
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    const settings = await chatSettingsRepository.ensure(chatId);
    const lang = settings.language ?? DEFAULT_LANGUAGE;

    const removedCount = await tokenRepository.removeByAddress(address);

    await ctx
      .editMessageText(
        removedCount > 0
          ? t(lang, "removeToken.removed", { address, count: removedCount, entries: t(lang, "removeToken.entriesWord") })
          : t(lang, "removeToken.alreadyRemoved", { address }),
      )
      .catch(() => undefined);
    await ctx.answerCbQuery();
  });

  bot.action("remove:cancel", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    const settings = await chatSettingsRepository.ensure(chatId);
    const lang = settings.language ?? DEFAULT_LANGUAGE;

    await ctx.editMessageText(t(lang, "removeToken.cancelled")).catch(() => undefined);
    await ctx.answerCbQuery(t(lang, "removeToken.cancelled"));
  });
}
