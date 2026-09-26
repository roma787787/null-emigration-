import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";

/**
 * Manual owner/wallet linking (spec section 4.1): lets a chat attach extra
 * addresses to a tracked token — devs, multisigs — that auto-discovery
 * (owner()/admin()/deployer lookup) won't find on its own.
 */
export function registerAddOwnerCommand(bot: Telegraf): void {
  bot.command("add_owner", async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [networkArg, tokenArg, ownerArg] = args;

    if (!networkArg || !tokenArg || !ownerArg) {
      await ctx.reply(
        `Usage: /add_owner <network> <token_a_address> <owner_address>\nSupported networks: ${allNetworkKeys().join(", ")}`,
      );
      return;
    }

    const network = networkArg.toLowerCase();
    if (!isKnownNetwork(network)) {
      await ctx.reply(`Unknown network "${networkArg}". Supported: ${allNetworkKeys().join(", ")}`);
      return;
    }

    if (!isAddress(tokenArg) || !isAddress(ownerArg)) {
      await ctx.reply("Both the token and owner addresses must be valid EVM addresses.");
      return;
    }

    const tokenAddress = getAddress(tokenArg);
    const ownerAddress = getAddress(ownerArg);

    const token = await tokenRepository.findByNetworkAndAddress(network, tokenAddress);
    if (!token) {
      await ctx.reply(`${tokenAddress} on ${network} isn't tracked yet — add it first with /add_token.`);
      return;
    }

    await ownerRepository.upsert(token.id, ownerAddress, "manual");
    await ctx.reply(`✅ Linked ${ownerAddress} to ${token.symbol ?? tokenAddress} as a manually-added owner.`);
  });
}
