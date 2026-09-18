import type { Telegraf } from "telegraf";
import { getAddress, isAddress } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { getPublicClient } from "../../chain/provider.js";
import { discoverAllOwners } from "../../chain/ownerDiscovery.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { logger } from "../../utils/logger.js";

const NAME_SYMBOL_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export function registerAddTokenCommand(bot: Telegraf): void {
  bot.command("add_token", async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const [networkArg, addressArg] = args;

    if (!networkArg || !addressArg) {
      await ctx.reply(
        `Usage: /add_token <network> <token_a_address>\nSupported networks: ${allNetworkKeys().join(", ")}`,
      );
      return;
    }

    const network = networkArg.toLowerCase();
    if (!isKnownNetwork(network)) {
      await ctx.reply(`Unknown network "${networkArg}". Supported: ${allNetworkKeys().join(", ")}`);
      return;
    }

    if (!isAddress(addressArg)) {
      await ctx.reply(`"${addressArg}" is not a valid EVM address.`);
      return;
    }

    const address = getAddress(addressArg);
    const chatId = String(ctx.chat.id);

    await chatSettingsRepository.ensure(chatId);

    await ctx.reply(`Looking up ${address} on ${network}...`);

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
        : "  • None found automatically — you can link wallets manually later.";

    await ctx.reply(
      [
        `✅ Now tracking ${symbol ?? "token"} (${address}) on ${network}.`,
        "",
        "Discovered owners/admins:",
        ownerLines,
      ].join("\n"),
    );
  });
}
