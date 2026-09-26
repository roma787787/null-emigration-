import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

export function registerRemoveOwnerCommand(bot: Telegraf): void {
  bot.command("remove_owner", async (ctx) => {
    const settings = await chatSettingsRepository.ensure(String(ctx.chat.id));
    const lang = settings.language ?? DEFAULT_LANGUAGE;
    const networksList = allNetworkKeys().join(", ");

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [networkArg, tokenArg, ownerArg] = args;

    if (!networkArg || !tokenArg || !ownerArg) {
      await ctx.reply(t(lang, "removeOwner.usage", { networks: networksList }));
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
      await ctx.reply(t(lang, "removeOwner.tokenNotTracked", { address: tokenAddress, network }));
      return;
    }

    const removed = await ownerRepository.remove(token.id, ownerAddress);
    await ctx.reply(
      removed
        ? t(lang, "removeOwner.unlinked", { owner: ownerAddress, symbol: token.symbol ?? tokenAddress })
        : t(lang, "removeOwner.notLinked", { owner: ownerAddress, symbol: token.symbol ?? tokenAddress }),
    );
  });
}
