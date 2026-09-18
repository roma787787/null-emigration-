import type { Telegraf } from "telegraf";
import { allNetworkKeys, isKnownNetwork } from "../../config/networks.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import type { NetworkKey } from "../../types/index.js";

function formatSettings(confidenceFilter: string, networksFilter: NetworkKey[] | null): string {
  return [
    "⚙️ Current settings:",
    `  Confidence filter: ${confidenceFilter}`,
    `  Networks: ${networksFilter ? networksFilter.join(", ") : "all"}`,
    "",
    "Change with:",
    "  /settings confidence all|high",
    "  /settings networks all|<net1,net2,...>",
    `  Supported networks: ${allNetworkKeys().join(", ")}`,
  ].join("\n");
}

export function registerSettingsCommand(bot: Telegraf): void {
  bot.command("settings", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [sub, value] = args;

    if (!sub) {
      const settings = await chatSettingsRepository.ensure(chatId);
      await ctx.reply(formatSettings(settings.confidenceFilter, settings.networksFilter));
      return;
    }

    if (sub === "confidence") {
      if (value === "all") {
        await chatSettingsRepository.setConfidenceFilter(chatId, "ALL");
        await ctx.reply("Confidence filter set to ALL.");
      } else if (value === "high") {
        await chatSettingsRepository.setConfidenceFilter(chatId, "HIGH_ONLY");
        await ctx.reply("Confidence filter set to HIGH_ONLY.");
      } else {
        await ctx.reply("Usage: /settings confidence all|high");
      }
      return;
    }

    if (sub === "networks") {
      if (value === "all") {
        await chatSettingsRepository.setNetworksFilter(chatId, null);
        await ctx.reply("Now receiving alerts for all supported networks.");
        return;
      }

      const requested = (value ?? "").split(",").map((n) => n.trim().toLowerCase());
      const invalid = requested.filter((n) => !isKnownNetwork(n));
      if (requested.length === 0 || invalid.length > 0) {
        await ctx.reply(
          invalid.length > 0
            ? `Unknown network(s): ${invalid.join(", ")}. Supported: ${allNetworkKeys().join(", ")}`
            : "Usage: /settings networks all|<net1,net2,...>",
        );
        return;
      }

      await chatSettingsRepository.setNetworksFilter(chatId, requested as NetworkKey[]);
      await ctx.reply(`Now receiving alerts only for: ${requested.join(", ")}`);
      return;
    }

    await ctx.reply(formatSettings("ALL", null));
  });
}
