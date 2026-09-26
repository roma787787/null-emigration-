import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { buildRemoveConfirmView } from "../views/removeTokenView.js";

export function registerRemoveTokenCommand(bot: Telegraf): void {
  bot.command("remove_token", async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [addressArg] = args;

    if (!addressArg || !isAddress(addressArg)) {
      await ctx.reply("Usage: /remove_token <token_a_address>");
      return;
    }

    const address = getAddress(addressArg);
    const tokens = await tokenRepository.listByAddress(address);

    if (tokens.length === 0) {
      await ctx.reply(`${address} was not being tracked.`);
      return;
    }

    const { text, keyboard } = buildRemoveConfirmView(tokens, address);
    await ctx.reply(text, keyboard);
  });
}
