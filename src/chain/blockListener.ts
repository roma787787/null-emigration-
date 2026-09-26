import type { Address } from "viem";
import type { ContractCreationEvent, NetworkKey } from "../types/index.js";
import { getPublicClient } from "./provider.js";
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
 */
export function startBlockListener(network: NetworkKey, onContractCreation: ContractCreationHandler): () => void {
  const client = getPublicClient(network);
  let processing = Promise.resolve();
  let lastProcessedBlock: bigint | null = null;

  const unwatch = client.watchBlockNumber({
    emitOnBegin: true,
    poll: true,
    pollingInterval: env.BLOCK_POLL_INTERVAL_MS,
    onBlockNumber: (blockNumber) => {
      processing = processing.then(async () => {
        const from = lastProcessedBlock === null ? blockNumber : lastProcessedBlock + 1n;
        for (let bn = from; bn <= blockNumber; bn++) {
          await processBlock(network, bn, onContractCreation).catch((err) => {
            logger.error({ err, network, blockNumber: bn.toString() }, "Failed to process block");
          });
        }
        lastProcessedBlock = blockNumber;
      });
    },
    onError: (err) => {
      logger.error({ err, network }, "Block watcher error");
    },
  });

  logger.info({ network }, "Started block listener");
  return unwatch;
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
