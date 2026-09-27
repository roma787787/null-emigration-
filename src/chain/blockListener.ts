import type { Address } from "viem";
import type { ContractCreationEvent, NetworkKey } from "../types/index.js";
import { getPublicClient, networkHasWebSocket } from "./provider.js";
import { ownerRepository } from "../db/repositories/ownerRepository.js";
import { networkCursorRepository } from "../db/repositories/networkCursorRepository.js";
import { initListenerStatus, recordListenerError } from "./listenerStatus.js";
import { findFactoryCreatedContracts } from "./traceCreateDetector.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TrackedContractCreationEvent extends ContractCreationEvent {
  tokenIds: number[];
}

export type ContractCreationHandler = (event: TrackedContractCreationEvent) => void | Promise<void>;

const CURSOR_AHEAD_LIMIT = 64n;

/**
 * Which blocks to process when head `head` arrives: everything after the
 * last processed block, but at most `maxCatchup` of the newest ones (a long
 * downtime would otherwise mean replaying hours of blocks before any live
 * alert). With no cursor yet, only the head itself.
 */
export function blockRange(
  lastProcessed: bigint | null,
  head: bigint,
  maxCatchup: number,
): { from: bigint; skipped: number } | null {
  // A cursor far ahead of the chain belongs to some other chain (a reset
  // devnet, a redefined custom network): start over from the head instead of
  // waiting forever for the chain to reach it.
  if (lastProcessed !== null && lastProcessed > head + CURSOR_AHEAD_LIMIT) lastProcessed = null;
  if (lastProcessed !== null && head <= lastProcessed) return null;
  const wanted = lastProcessed === null ? head : lastProcessed + 1n;
  const earliest = head - BigInt(Math.max(1, maxCatchup)) + 1n;
  return wanted < earliest ? { from: earliest, skipped: Number(earliest - wanted) } : { from: wanted, skipped: 0 };
}

const CURSOR_SAVE_INTERVAL_MS = 5_000;

/**
 * Watches a single network for new blocks and reports contract deployments
 * originating from a tracked owner/deployer address (section 4.2 of the
 * spec). Covers two paths:
 *
 *  - direct EOA deployment (`tx.to === null`), via the tx receipt's
 *    `contractAddress`;
 *  - factory-mediated deployment (the owner calls a contract, which
 *    internally CREATEs/CREATE2s a new contract), via
 *    `debug_traceTransaction` when the RPC endpoint supports it — see
 *    traceCreateDetector.ts for the capability-detection/fallback behavior.
 *
 * When a `wss://` RPC is configured for this network, new blocks arrive via
 * a push `eth_subscribe` WebSocket subscription instead of polling — this is
 * what makes the spec's 5-10s alert-latency target achievable. Falls back to
 * HTTP polling (`BLOCK_POLL_INTERVAL_MS`) otherwise.
 *
 * Progress is saved per network (network_cursors), so after a restart the
 * listener first replays the blocks it missed (see blockRange).
 */
export function startBlockListener(
  network: NetworkKey,
  onContractCreation: ContractCreationHandler,
): () => Promise<void> {
  const client = getPublicClient(network);
  const usesWebSocket = networkHasWebSocket(network);
  const status = initListenerStatus(network, usesWebSocket ? "websocket" : "polling");
  let lastProcessedBlock: bigint | null = null;
  let savedBlock: bigint | null = null;
  let lastSavedAt = 0;
  let stopped = false;

  const saveCursor = async (force: boolean) => {
    if (lastProcessedBlock === null || lastProcessedBlock === savedBlock) return;
    if (!force && Date.now() - lastSavedAt < CURSOR_SAVE_INTERVAL_MS) return;
    const block = lastProcessedBlock;
    lastSavedAt = Date.now();
    try {
      await networkCursorRepository.save(network, block);
      savedBlock = block;
    } catch (err) {
      logger.warn({ err, network }, "Failed to save block cursor");
    }
  };

  // Resume from the block the previous run finished, so nothing mined during
  // a redeploy/crash is missed.
  let processing: Promise<void> = networkCursorRepository
    .get(network)
    .then((cursor) => {
      lastProcessedBlock = savedBlock = cursor;
      if (cursor !== null) logger.info({ network, cursor: cursor.toString() }, "Resuming from saved block cursor");
    })
    .catch((err) => logger.warn({ err, network }, "Could not load block cursor; starting from the chain head"));

  const onBlockNumber = (blockNumber: bigint) => {
    processing = processing.then(async () => {
      try {
        const range = blockRange(lastProcessedBlock, blockNumber, env.MAX_CATCHUP_BLOCKS);
        if (!range) return;
        if (range.skipped > 0) {
          status.skippedBlocks += range.skipped;
          logger.warn(
            { network, skipped: range.skipped, from: range.from.toString() },
            "Downtime longer than MAX_CATCHUP_BLOCKS — skipping the oldest missed blocks",
          );
        }
        const catchingUp = blockNumber - range.from > 1n;
        if (catchingUp) {
          logger.info({ network, blocks: (blockNumber - range.from + 1n).toString() }, "Catching up on missed blocks");
        }
        for (let bn = range.from; bn <= blockNumber && !stopped; bn++) {
          const ok = await processBlockWithRetry(network, bn, onContractCreation);
          if (!ok) status.failedBlocks++;
          lastProcessedBlock = bn;
          status.lastProcessedBlock = bn;
          status.lastProcessedAt = new Date();
          await saveCursor(false);
        }
        if (catchingUp) await saveCursor(true);
      } catch (err) {
        // Never let the chain reject: every later block would be skipped.
        recordListenerError(network, err);
        logger.error({ err, network }, "Unexpected block listener failure");
      }
    });
  };
  const onError = (err: Error) => {
    recordListenerError(network, err);
    logger.error({ err, network }, "Block watcher error");
  };

  // viem types `poll` as a discriminated literal keyed off the client's
  // transport generic, which collapses to the polling-only variant once the
  // transport is built from a runtime array of mixed http()/webSocket()
  // transports (TS can't see into that array's contents at the type level).
  // watchBlockNumber's actual runtime behavior only cares about `poll`'s
  // runtime value (see viem's watchBlockNumber.js), so this is a type-level
  // limitation, not a real unsoundness — hence the narrow cast.
  const watchBlockNumber = client.watchBlockNumber as (args: {
    emitOnBegin: boolean;
    poll: boolean;
    pollingInterval?: number;
    onBlockNumber: typeof onBlockNumber;
    onError: typeof onError;
  }) => () => void;

  const unwatch = watchBlockNumber({
    emitOnBegin: true,
    poll: !usesWebSocket,
    pollingInterval: env.BLOCK_POLL_INTERVAL_MS,
    onBlockNumber,
    onError,
  });

  logger.info({ network, mode: status.mode }, "Started block listener");

  // Stops watching, lets the block in flight finish, and persists the cursor.
  return async () => {
    unwatch();
    stopped = true;
    await processing;
    await saveCursor(true);
  };
}

const BLOCK_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

// A transient RPC/Redis failure must not silently drop a block's deployments,
// so each block is retried with backoff before it's given up on.
async function processBlockWithRetry(
  network: NetworkKey,
  blockNumber: bigint,
  onContractCreation: ContractCreationHandler,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await processBlock(network, blockNumber, onContractCreation);
      return true;
    } catch (err) {
      const delay = BLOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        recordListenerError(network, err);
        logger.error({ err, network, blockNumber: blockNumber.toString() }, "Giving up on block after retries");
        return false;
      }
      logger.warn({ err, network, blockNumber: blockNumber.toString(), attempt: attempt + 1 }, "Block processing failed, retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function processBlock(network: NetworkKey, blockNumber: bigint, onContractCreation: ContractCreationHandler) {
  const client = getPublicClient(network);
  const block = await client.getBlock({ blockNumber, includeTransactions: true });

  const txs = block.transactions.filter((tx): tx is Exclude<typeof tx, string> => typeof tx === "object");
  if (txs.length === 0) return;

  const uniqueSenders = [...new Set(txs.map((tx) => tx.from as Address))];
  const ownerMap = await ownerRepository.findTokenIdsForAddresses(uniqueSenders);
  if (ownerMap.size === 0) return;

  for (const tx of txs) {
    const tokenIds = ownerMap.get((tx.from as string).toLowerCase());
    if (!tokenIds || tokenIds.length === 0) continue;

    if (tx.to === null) {
      const receipt = await client.getTransactionReceipt({ hash: tx.hash });
      if (!receipt.contractAddress) continue;

      logger.info(
        { network, contractAddress: receipt.contractAddress, creator: tx.from, tokenIds },
        "Tracked owner deployed a new contract",
      );

      await onContractCreation({
        network,
        contractAddress: receipt.contractAddress,
        creatorAddress: tx.from as Address,
        txHash: tx.hash,
        blockNumber,
        input: tx.input,
        tokenIds,
      });
      continue;
    }

    if (!env.ENABLE_FACTORY_TRACE_DETECTION) continue;

    const created = await findFactoryCreatedContracts(client, network, tx.hash);
    for (const { address: contractAddress, input } of created) {
      logger.info(
        { network, contractAddress, creator: tx.from, via: tx.to, tokenIds },
        "Tracked owner deployed a new contract via a factory",
      );

      await onContractCreation({
        network,
        contractAddress,
        creatorAddress: tx.from as Address,
        txHash: tx.hash,
        blockNumber,
        input,
        tokenIds,
      });
    }
  }
}
