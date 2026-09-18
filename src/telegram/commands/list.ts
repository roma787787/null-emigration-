import type { Telegraf } from "telegraf";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";

export function registerListCommand(bot: Telegraf): void {
  bot.command("list", async (ctx) => {
    const tokens = await tokenRepository.listAll();

    if (tokens.length === 0) {
      await ctx.reply("No tokens are being tracked yet. Add one with /add_token <network> <address>.");
      return;
    }

    const blocks = await Promise.all(
      tokens.map(async (token) => {
        const owners = await ownerRepository.listForToken(token.id);
        const ownerLines =
          owners.length > 0
            ? owners.map((o) => `    • ${o.address} (${o.source})`).join("\n")
            : "    • none found";
        return [
          `🪙 ${token.symbol ?? "?"} — ${token.network} — ${token.address}`,
          "  Owners/admins:",
          ownerLines,
        ].join("\n");
      }),
    );

    // Telegram messages are capped at 4096 chars; chunk the reply if needed.
    const full = blocks.join("\n\n");
    const chunks = full.match(/[\s\S]{1,3800}/g) ?? [full];
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  });
}
