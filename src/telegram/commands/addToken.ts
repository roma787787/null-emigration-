import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { getPublicClient } from "../../chain/provider.js";
import { discoverAllOwners } from "../../chain/ownerDiscovery.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";
import { logger } from "../../utils/logger.js";

const NAME_SYMBOL_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export function registerAddTokenCommand(bot: Telegraf): void {
  bot.command("add_token", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const settings = await chatSettingsRepository.ensure(chatId);
    const lang = settings.language ?? DEFAULT_LANGUAGE;
    const networksList = allNetworkKeys().join(", ");

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [networkArg, addressArg] = args;

    if (!networkArg || !addressArg) {
      await ctx.reply(t(lang, "addToken.usage", { networks: networksList }));
      return;
    }

    const network = networkArg.toLowerCase();
    if (!isKnownNetwork(network)) {
      await ctx.reply(t(lang, "addToken.unknownNetwork", { network: networkArg, networks: networksList }));
      return;
    }

    if (!isAddress(addressArg)) {
      await ctx.reply(t(lang, "addToken.invalidAddress", { address: addressArg }));
      return;
    }

    const address = getAddress(addressArg);
    const alreadyTracked = (await tokenRepository.findByNetworkAndAddress(network, address)) !== null;

    await ctx.reply(t(lang, "addToken.lookingUp", { address, network }));

    let name: string | null = null;
    let symbol: string | null = null;
    try {
      const client = getPublicClient(network);
      [name, symbol] = await Promise.all([
        client.readContract({ address, abi: NAME_SYMBOL_ABI, functionName: "name" }).catch(() => null),
        client.readContract({ address, abi: NAME_SYMBOL_ABI, functionName: "symbol" }).catch(() => null),
      ]);
    } catch (err) {
      logger.warn({ err, network, address }, "Failed to read token metadata");
    }

    const token = await tokenRepository.add(network, address, chatId, { symbol, name });

    let owners: Awaited<ReturnType<typeof discoverAllOwners>> = [];
    try {
      owners = await discoverAllOwners(network, address);
      for (const owner of owners) {
        await ownerRepository.upsert(token.id, owner.address, owner.source);
      }
    } catch (err) {
      logger.error({ err, network, address }, "Owner discovery failed");
    }

    const ownerLines =
      owners.length > 0
        ? owners.map((o) => `  • ${o.address} (${o.source})`).join("\n")
        : t(lang, "addToken.ownersNone");

    await ctx.reply(
      // Re-adding re-runs owner discovery, so it doubles as a "refresh owners" action.
      t(lang, alreadyTracked ? "addToken.refreshed" : "addToken.success", {
        symbol: symbol ?? t(lang, "addToken.defaultSymbol"),
        address,
        network,
        owners: ownerLines,
      }),
    );
  });
}
