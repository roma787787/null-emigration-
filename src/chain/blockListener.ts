import type { Address } from "viem";
import type { ContractCreationEvent, NetworkKey } from "../types/index.js";
import { getPublicClient } from "./provider.js";
import { ownerRepository } from "../db/repositories/ownerRepository.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TrackedContractCreationEvent extends ContractCreationEvent {
  tokenIds: number[];
}

export type ContractCreationHandler = (event: TrackedContractCreationEvent) => void | Promise<void>;

/**
 * Watches a single network for new blocks and reports contract-creation
 * transactions (`to === null`) originating from a tracked owner/deployer
 * address (section 4.2 of the spec).
 *
 * Note: this only catches direct EOA-initiated CREATE deployments. Contracts
 * deployed via a factory's internal CREATE/CREATE2 (where `to` is the
 * factory, not null) require trace-level inspection (e.g. debug_traceBlock /
 * trace_block) which not all RPC providers expose — that path is left as a
 * documented extension point rather than implemented against a specific
 * provider's non-standard API.
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

  const creationTxs = block.transactions.filter(
    (tx): tx is typeof tx & { to: null } => typeof tx === "object" && tx.to === null,
  );

  for (const tx of creationTxs) {
    const tokenIds = await ownerRepository.findTokenIdsByOwnerAddress(tx.from as Address);
    if (tokenIds.length === 0) continue;

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
  }
}
