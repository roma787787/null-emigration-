import type { Telegraf } from "telegraf";
import { BaseError, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { getPublicClient } from "../../chain/provider.js";
import { analyzeDeployTx } from "../../analyzer/analyzeDeployTx.js";
import { pickReferencedToken } from "../../analyzer/pickToken.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import type { MigrationContractRecord, NetworkKey, TokenRecord } from "../../types/index.js";
import { formatMigrationAlert } from "../notificationFormatter.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";
import { logger } from "../../utils/logger.js";

const SYMBOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function isTxHash(value: string): value is Hex {
  return isHex(value) && value.length === 66;
}

/**
 * Token A for the card: an explicitly given address (tracked or not), else
 * the tracked token the creator owns that the contract references (same
 * network preferred) — see pickReferencedToken.
 */
async function resolveTokenA(
  network: NetworkKey,
  explicit: Address | null,
  creator: Address,
  creationInputs: Hex[],
): Promise<TokenRecord | null> {
  if (explicit) {
    const tracked = await tokenRepository.findByNetworkAndAddress(network, explicit);
    if (tracked) return tracked;
    const symbol = await getPublicClient(network)
      .readContract({ address: explicit, abi: SYMBOL_ABI, functionName: "symbol" })
      .catch(() => null);
    return { id: 0, network, address: explicit, symbol, name: null, addedByChatId: "", createdAt: new Date() };
  }

  const tokenIds = await ownerRepository.findTokenIdsByOwnerAddress(creator);
  const candidates = (await Promise.all(tokenIds.map((id) => tokenRepository.findById(id))))
    .filter((t): t is TokenRecord => t !== null)
    .sort((x, y) => Number(y.network === network) - Number(x.network === network));
  return pickReferencedToken(candidates, creationInputs);
}

/**
 * /analyze <network> <deploy_tx_hash> [token_a_address] — runs the migration
 * analyzer on contracts created by an already-mined transaction and replies
 * with the same card a live detection would produce. Nothing is stored or
 * broadcast; it's for checking real-world contracts on demand.
 */
export function registerAnalyzeCommand(bot: Telegraf): void {
  bot.command("analyze", async (ctx) => {
    const settings = await chatSettingsRepository.ensure(String(ctx.chat.id));
    const lang = settings.language ?? DEFAULT_LANGUAGE;
    const networksList = allNetworkKeys().join(", ");

    const [networkArg, hashArg, tokenArg] = ctx.message.text.trim().split(/\s+/).slice(1);

    if (!networkArg || !hashArg) {
      await ctx.reply(t(lang, "analyze.usage", { networks: networksList }));
      return;
    }

    const network = networkArg.toLowerCase();
    if (!isKnownNetwork(network)) {
      await ctx.reply(t(lang, "addToken.unknownNetwork", { network: networkArg, networks: networksList }));
      return;
    }
    if (!isTxHash(hashArg)) {
      await ctx.reply(t(lang, "analyze.invalidHash", { hash: hashArg }));
      return;
    }
    if (tokenArg && !isAddress(tokenArg)) {
      await ctx.reply(t(lang, "addToken.invalidAddress", { address: tokenArg }));
      return;
    }

    const explicitTokenA = tokenArg ? getAddress(tokenArg) : null;
    await ctx.reply(t(lang, "analyze.working", { hash: hashArg, network }));

    try {
      let tokenA: TokenRecord | null = null;
      const result = await analyzeDeployTx(network, hashArg, async (creator, creationInputs) => {
        tokenA = await resolveTokenA(network, explicitTokenA, creator, creationInputs);
        return tokenA?.address ?? null;
      });

      if (result.status === "not_found") {
        await ctx.reply(t(lang, "analyze.notFound", { hash: hashArg, network }));
        return;
      }
      if (result.status === "reverted") {
        await ctx.reply(t(lang, "analyze.reverted"));
        return;
      }
      if (result.status === "no_contract") {
        await ctx.reply(t(lang, "analyze.noContract", { network }));
        return;
      }

      for (const { contractAddress, analysis } of result.deployments) {
        const record: MigrationContractRecord = {
          id: 0,
          tokenId: (tokenA as TokenRecord | null)?.id ?? 0,
          network,
          contractAddress,
          creatorAddress: result.creator,
          ...analysis,
          txHash: hashArg,
          blockNumber: result.blockNumber,
          detectedAt: new Date(),
        };
        await ctx.reply(formatMigrationAlert(tokenA, record, lang, { manual: true }), {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
        });
      }
    } catch (err) {
      logger.error({ err, network, hash: hashArg }, "/analyze failed");
      const message = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
      await ctx.reply(t(lang, "analyze.failed", { error: message.slice(0, 300) }));
    }
  });
}
