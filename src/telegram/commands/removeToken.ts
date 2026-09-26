import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { buildRemoveConfirmView } from "../views/removeTokenView.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

export function registerRemoveTokenCommand(bot: Telegraf): void {
  bot.command("remove_token", async (ctx) => {
    const settings = await chatSettingsRepository.ensure(String(ctx.chat.id));
    const lang = settings.language ?? DEFAULT_LANGUAGE;

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [addressArg] = args;

    if (!addressArg || !isAddress(addressArg)) {
      await ctx.reply(t(lang, "removeToken.usage"));
      return;
    }

    const address = getAddress(addressArg);
    const tokens = await tokenRepository.listByAddress(address);

    if (tokens.length === 0) {
      await ctx.reply(t(lang, "removeToken.notTracked", { address }));
      return;
    }

    const { text, keyboard } = buildRemoveConfirmView(tokens, address, lang);
    await ctx.reply(text, keyboard);
  });
}
