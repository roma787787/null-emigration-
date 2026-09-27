import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { allNetworkKeys, isKnownNetwork } from "../../config/networks.js";
import { custodianRepository } from "../../db/repositories/custodianRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { isAdminChat } from "../accessControl.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

/**
 * Admin-only registry of RWA / tokenized-stock deployers (Backed, Dinari,
 * Robinhood...). Their deployments are always analyzed and skip the DEX
 * liquidity filter, since tokenized stocks don't trade on DEXes at launch.
 *
 *   /custodians
 *   /add_custodian <network> <deployer_address> <label...>
 *   /remove_custodian <network> <deployer_address>
 */
export function registerCustodianCommands(bot: Telegraf): void {
  const guard = async (chatId: string) => {
    const lang = (await chatSettingsRepository.ensure(chatId)).language ?? DEFAULT_LANGUAGE;
    return { lang, allowed: isAdminChat(chatId) };
  };

  bot.command("custodians", async (ctx) => {
    const { lang, allowed } = await guard(String(ctx.chat.id));
    if (!allowed) return void (await ctx.reply(t(lang, "status.adminOnly")));
    const rows = await custodianRepository.listAll();
    await ctx.reply(
      rows.length === 0
        ? t(lang, "custodians.empty")
        : [t(lang, "custodians.header"), ...rows.map((r) => `  • ${r.label} — ${r.network} — ${r.address}`)].join("\n"),
    );
  });

  bot.command("add_custodian", async (ctx) => {
    const { lang, allowed } = await guard(String(ctx.chat.id));
    if (!allowed) return void (await ctx.reply(t(lang, "status.adminOnly")));
    const [networkArg, addressArg, ...labelParts] = ctx.message.text.trim().split(/\s+/).slice(1);
    const label = labelParts.join(" ");
    const network = networkArg?.toLowerCase();
    if (!network || !addressArg || !label) {
      return void (await ctx.reply(t(lang, "custodians.addUsage", { networks: allNetworkKeys().join(", ") })));
    }
    if (!isKnownNetwork(network)) {
      return void (await ctx.reply(t(lang, "addToken.unknownNetwork", { network: networkArg!, networks: allNetworkKeys().join(", ") })));
    }
    if (!isAddress(addressArg)) return void (await ctx.reply(t(lang, "addToken.invalidAddress", { address: addressArg })));
    await custodianRepository.upsert(network, getAddress(addressArg), label);
    await ctx.reply(t(lang, "custodians.added", { label, network, address: getAddress(addressArg) }));
  });

  bot.command("remove_custodian", async (ctx) => {
    const { lang, allowed } = await guard(String(ctx.chat.id));
    if (!allowed) return void (await ctx.reply(t(lang, "status.adminOnly")));
    const [networkArg, addressArg] = ctx.message.text.trim().split(/\s+/).slice(1);
    if (!networkArg || !addressArg || !isAddress(addressArg)) {
      return void (await ctx.reply(t(lang, "custodians.removeUsage")));
    }
    const removed = await custodianRepository.remove(networkArg.toLowerCase(), addressArg);
    await ctx.reply(t(lang, removed ? "custodians.removed" : "custodians.notFound", { address: getAddress(addressArg) }));
  });
}
