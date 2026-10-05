import type { Telegraf } from "telegraf";
import { BaseError, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { isKnownNetwork, allNetworkKeys } from "../../config/networks.js";
import { getPublicClient } from "../../chain/provider.js";
import { readTokenSymbol } from "../../chain/tokenMetadata.js";
import { analyzeDeployTx } from "../../analyzer/analyzeDeployTx.js";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import type { MigrationContractRecord, NetworkKey, TokenRecord } from "../../types/index.js";
import { formatMigrationAlert } from "../notificationFormatter.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { analyzeAutoCandidate } from "../../analyzer/autoAnalyzer.js";
import { applyLiquidityRules, type LiquidityDecision } from "../../queue/notificationQueue.js";
import { findDeployTx } from "../../chain/creationLookup.js";
import { termsFor } from "../../analyzer/migrationTerms.js";

function isTxHash(value: string): value is Hex {
  return isHex(value) && value.length === 66;
}

/**
 * Token A candidates for the card: an explicitly given address (tracked or
 * not), else the tracked tokens the creator owns, same network first. The
 * analyzer then picks the one the contract actually references.
 */
async function tokenACandidates(network: NetworkKey, explicit: Address | null, creator: Address): Promise<TokenRecord[]> {
  if (explicit) {
    const tracked = await tokenRepository.findByNetworkAndAddress(network, explicit);
    if (tracked) return [tracked];
    const symbol = await readTokenSymbol(getPublicClient(network), explicit);
    return [{ id: 0, network, address: explicit, symbol, name: null, addedByChatId: "", createdAt: new Date() }];
  }

  const tokenIds = await ownerRepository.findTokenIdsByOwnerAddress(creator);
  return (await Promise.all(tokenIds.map((id) => tokenRepository.findById(id))))
    .filter((t): t is TokenRecord => t !== null)
    .sort((x, y) => Number(y.network === network) - Number(x.network === network));
}

/**
 * /analyze <network> <deploy_tx_hash | contract_address> [token_a_address] —
 * runs the migration analyzer on contracts created by an already-mined
 * transaction (when given the contract's address, found through the
 * explorer API, else on-chain) and replies with the same card a live detection would produce,
 * plus what auto-discovery would have done with it and in which block.
 * Nothing is stored or broadcast; it's for checking real-world contracts on
 * demand.
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
    if (!isTxHash(hashArg) && !isAddress(hashArg)) {
      await ctx.reply(t(lang, "analyze.invalidHash", { hash: hashArg }));
      return;
    }
    if (tokenArg && !isAddress(tokenArg)) {
      await ctx.reply(t(lang, "addToken.invalidAddress", { address: tokenArg }));
      return;
    }

    const explicitTokenA = tokenArg ? getAddress(tokenArg) : null;

    // Given the contract's address: find the transaction that deployed it.
    let hash: Hex;
    let onlyContract: Address | null = null;
    if (isTxHash(hashArg)) {
      hash = hashArg;
    } else {
      onlyContract = getAddress(hashArg);
      await ctx.reply(t(lang, "analyze.lookingUp", { address: onlyContract, network }));
      const found = await findDeployTx(network, onlyContract);
      if (!found) {
        await ctx.reply(t(lang, "analyze.creationUnknown", { address: onlyContract, network }));
        return;
      }
      hash = found;
    }
    await ctx.reply(t(lang, "analyze.working", { hash, network }));

    try {
      let candidates: TokenRecord[] = [];
      const result = await analyzeDeployTx(network, hash, async (creator) => {
        candidates = await tokenACandidates(network, explicitTokenA, creator);
        return candidates.map((c) => c.address);
      });

      if (result.status === "not_found") {
        await ctx.reply(t(lang, "analyze.notFound", { hash, network }));
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

      const deployments = onlyContract
        ? result.deployments.filter((d) => d.contractAddress.toLowerCase() === onlyContract.toLowerCase())
        : result.deployments;
      for (const { contractAddress, input, analysis } of deployments.length > 0 ? deployments : result.deployments) {
        const { tokenAAddress, ...fields } = analysis;
        const tokenA =
          candidates.find((c) => tokenAAddress && c.address.toLowerCase() === tokenAAddress.toLowerCase()) ?? null;
        let record: MigrationContractRecord = {
          id: 0,
          tokenId: tokenA?.id ?? null,
          discovery: "tracked",
          tokenAAddress: tokenA?.address ?? null,
          tokenASymbol: tokenA?.symbol ?? null,
          liquidity: null,
          custodianLabel: null,
          network,
          contractAddress,
          creatorAddress: result.creator,
          ...fields,
          txHash: hash,
          blockNumber: result.blockNumber,
          detectedAt: new Date(),
        };
        // What auto-discovery makes of it. With no Token A given or tracked,
        // the card reads Token A from the contract the same way and runs the
        // same liquidity test.
        // The same steps as live, the liquidity rules (which token is the old
        // one, dollar converters, swap bots) included.
        const auto = await analyzeAutoCandidate(network, contractAddress, input).catch(() => null);
        let verdict: LiquidityDecision | null = null;
        if (auto?.kind === "candidate") verdict = await applyLiquidityRules(network, auto.result, null).catch(() => null);
        if (!tokenA && verdict) {
          const { alternateTokenA: _alt, tokenAGetter: _getter, codeHash: _code, swapOnly: _swapOnly, ...autoFields } = verdict.result;
          record = { ...record, ...autoFields, discovery: "auto", liquidity: verdict.liquidity };
        }
        record = {
          ...record,
          terms: await termsFor(network, contractAddress, record.tokenAAddress, record.tokenBAddress, verdict?.liquidity?.LOW_CAP),
        };
        await ctx.reply(formatMigrationAlert(tokenA, record, lang, { manual: true }), {
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
        });
        const block = result.blockNumber.toString();
        await ctx.reply(
          !auto
            ? t(lang, "analyze.autoFailed", { block })
            : auto.kind === "skipped"
              ? t(lang, "analyze.autoSkipped", { reason: auto.reason, block })
              : verdict?.kind === "pass"
                ? t(lang, "analyze.autoAlert", { block })
                : verdict?.kind === "drop"
                  ? t(lang, "analyze.autoSkipped", { reason: verdict.reason, block })
                  : t(lang, "analyze.autoCandidate", { block }),
        );
      }
    } catch (err) {
      logger.error({ err, network, hash }, "/analyze failed");
      const message = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
      await ctx.reply(t(lang, "analyze.failed", { error: message.slice(0, 300) }));
    }
  });
}
