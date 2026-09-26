import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

/**
 * Manual owner/wallet linking (spec section 4.1): lets a chat attach extra
 * addresses to a tracked token — devs, multisigs — that auto-discovery
 * (owner()/admin()/deployer lookup) won't find on its own.
 */
export function registerAddOwnerCommand(bot: Telegraf): void {
  bot.command("add_owner", async (ctx) => {
    const settings = await chatSettingsRepository.ensure(String(ctx.chat.id));
    const lang = settings.language ?? DEFAULT_LANGUAGE;
    const networksList = allNetworkKeys().join(", ");

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [networkArg, tokenArg, ownerArg] = args;

    if (!networkArg || !tokenArg || !ownerArg) {
      await ctx.reply(t(lang, "addOwner.usage", { networks: networksList }));
      return;
    }

    const network = networkArg.toLowerCase();
    if (!isKnownNetwork(network)) {
      await ctx.reply(t(lang, "addToken.unknownNetwork", { network: networkArg, networks: networksList }));
      return;
    }

    if (!isAddress(tokenArg) || !isAddress(ownerArg)) {
      await ctx.reply(t(lang, "ownerAddress.invalid"));
      return;
    }

    const tokenAddress = getAddress(tokenArg);
    const ownerAddress = getAddress(ownerArg);

    const token = await tokenRepository.findByNetworkAndAddress(network, tokenAddress);
    if (!token) {
      await ctx.reply(t(lang, "addOwner.tokenNotTracked", { address: tokenAddress, network }));
      return;
    }

    await ownerRepository.upsert(token.id, ownerAddress, "manual");
    await ctx.reply(t(lang, "addOwner.linked", { owner: ownerAddress, symbol: token.symbol ?? tokenAddress }));
  });
}
