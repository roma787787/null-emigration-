import type { Address } from "viem";
import type { ContractCreationEvent, NetworkKey } from "../types/index.js";
import { getPublicClient, networkHasWebSocket } from "./provider.js";
import { ownerRepository } from "../db/repositories/ownerRepository.js";
import { findFactoryCreatedContracts } from "./traceCreateDetector.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TrackedContractCreationEvent extends ContractCreationEvent {
  tokenIds: number[];
}

export type ContractCreationHandler = (event: TrackedContractCreationEvent) => void | Promise<void>;

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
 */
export function startBlockListener(network: NetworkKey, onContractCreation: ContractCreationHandler): () => void {
  const client = getPublicClient(network);
  const usesWebSocket = networkHasWebSocket(network);
  let processing = Promise.resolve();
  let lastProcessedBlock: bigint | null = null;

  const onBlockNumber = (blockNumber: bigint) => {
    processing = processing.then(async () => {
      const from = lastProcessedBlock === null ? blockNumber : lastProcessedBlock + 1n;
      for (let bn = from; bn <= blockNumber; bn++) {
        await processBlockWithRetry(network, bn, onContractCreation);
      }
      lastProcessedBlock = blockNumber;
    });
  };
  const onError = (err: Error) => {
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

  logger.info({ network, mode: usesWebSocket ? "websocket" : "polling" }, "Started block listener");
  return unwatch;
}

const BLOCK_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

// A transient RPC/Redis failure must not silently drop a block's deployments,
// so each block is retried with backoff before it's given up on.
async function processBlockWithRetry(
  network: NetworkKey,
  blockNumber: bigint,
  onContractCreation: ContractCreationHandler,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await processBlock(network, blockNumber, onContractCreation);
      return;
    } catch (err) {
      const delay = BLOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        logger.error({ err, network, blockNumber: blockNumber.toString() }, "Giving up on block after retries");
        return;
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
