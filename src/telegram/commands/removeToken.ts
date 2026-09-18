import type { Telegraf } from "telegraf";
import { isAddress } from "viem";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";

export function registerRemoveTokenCommand(bot: Telegraf): void {
  bot.command("remove_token", async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [addressArg] = args;

    if (!addressArg || !isAddress(addressArg)) {
      await ctx.reply("Usage: /remove_token <token_a_address>");
      return;
    }

    const removedCount = await tokenRepository.removeByAddress(addressArg);

    await ctx.reply(
      removedCount > 0
        ? `🗑 Removed ${addressArg} (${removedCount} network entr${removedCount === 1 ? "y" : "ies"}) from tracking.`
        : `${addressArg} was not being tracked.`,
    );
  });
}
