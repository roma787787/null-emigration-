import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redisClient.js";
import type { MigrationContractRecord, NetworkKey, TokenRecord } from "../types/index.js";
import { analyzeMigrationContract } from "../analyzer/migrationAnalyzer.js";
import { migrationContractRepository } from "../db/repositories/migrationContractRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import type { TrackedContractCreationEvent } from "../chain/blockListener.js";
import { logger } from "../utils/logger.js";

const QUEUE_NAME = "contract-creation-events";

// Job payloads must be JSON-serializable, so bigint block numbers travel as strings.
export interface ContractCreationJobData {
  network: NetworkKey;
  contractAddress: `0x${string}`;
  creatorAddress: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: string;
  input: `0x${string}`;
  tokenId: number;
}

let queue: Queue<ContractCreationJobData> | undefined;

export function getContractCreationQueue(): Queue<ContractCreationJobData> {
  if (!queue) {
    queue = new Queue<ContractCreationJobData>(QUEUE_NAME, { connection: createRedisConnection() });
  }
  return queue;
}

export async function enqueueContractCreation(event: TrackedContractCreationEvent): Promise<void> {
  const q = getContractCreationQueue();
  // A single deployment maps to one migration_contracts row (network, address
  // is unique); if the deployer happens to be a tracked owner of more than
  // one token, we attribute the event to the first match.
  const tokenId = event.tokenIds[0];
  if (tokenId === undefined) return;

  await q.add(
    "analyze",
    {
      network: event.network,
      contractAddress: event.contractAddress,
      creatorAddress: event.creatorAddress,
      txHash: event.txHash,
      blockNumber: event.blockNumber.toString(),
      input: event.input,
      tokenId,
    },
    {
      jobId: `${event.network}:${event.contractAddress.toLowerCase()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

export interface AnalyzedMigration {
  token: TokenRecord;
  migrationContract: MigrationContractRecord;
}

export function startContractCreationWorker(onAnalyzed: (result: AnalyzedMigration) => Promise<void>): Worker {
  const worker = new Worker<ContractCreationJobData>(
    QUEUE_NAME,
    async (job: Job<ContractCreationJobData>) => {
      const data = job.data;

      const alreadySeen = await migrationContractRepository.alreadySeen(data.network, data.contractAddress);
      if (alreadySeen) {
        logger.debug({ data }, "Contract already analyzed, skipping");
        return;
      }

      const token = await tokenRepository.findById(data.tokenId);
      if (!token) {
        logger.warn({ tokenId: data.tokenId }, "Token no longer tracked, dropping job");
        return;
      }

      const analysis = await analyzeMigrationContract(data.network, data.contractAddress, data.input);

      const migrationContract = await migrationContractRepository.create({
        tokenId: token.id,
        network: data.network,
        contractAddress: data.contractAddress,
        creatorAddress: data.creatorAddress,
        tokenBAddress: analysis.tokenBAddress,
        confidence: analysis.confidence,
        matchedFunctions: analysis.matchedFunctions,
        txHash: data.txHash,
        blockNumber: BigInt(data.blockNumber),
      });

      if (!migrationContract) {
        logger.debug({ data }, "Duplicate insert race, skipping notification");
        return;
      }

      await onAnalyzed({ token, migrationContract });
    },
    { connection: createRedisConnection(), concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "Contract creation analysis job failed");
  });

  return worker;
}
