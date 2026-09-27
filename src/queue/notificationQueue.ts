import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redisClient.js";
import type { MigrationContractRecord, NetworkKey, TokenRecord } from "../types/index.js";
import { analyzeMigrationContract } from "../analyzer/migrationAnalyzer.js";
import { migrationContractRepository } from "../db/repositories/migrationContractRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import { recheckOutcome } from "../analyzer/recheck.js";
import { env } from "../config/env.js";
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
  /** Every tracked token the creator owns; the worker picks the one the contract references. */
  tokenIds: number[];
  /** Pre-tokenIds job payloads still sitting in Redis from an older deploy. */
  tokenId?: number;
}

/** A delayed re-analysis of a contract detected without Token B. */
export interface RecheckJobData {
  network: NetworkKey;
  contractAddress: `0x${string}`;
  input: `0x${string}`;
  /** Index into RECHECK_DELAYS_SEC. */
  attempt: number;
}

type JobData = ContractCreationJobData | RecheckJobData;

let queue: Queue<JobData> | undefined;

export function getContractCreationQueue(): Queue<JobData> {
  if (!queue) {
    queue = new Queue<JobData>(QUEUE_NAME, { connection: createRedisConnection() });
  }
  return queue;
}

async function scheduleRecheck(base: Omit<RecheckJobData, "attempt">, attempt: number): Promise<void> {
  const delaySec = env.RECHECK_DELAYS_SEC[attempt];
  if (delaySec === undefined) return;
  await getContractCreationQueue().add(
    "recheck",
    { ...base, attempt },
    {
      jobId: `${base.network}-${base.contractAddress.toLowerCase()}-recheck-${attempt}`,
      delay: delaySec * 1000,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

export async function enqueueContractCreation(event: TrackedContractCreationEvent): Promise<void> {
  const q = getContractCreationQueue();
  if (event.tokenIds.length === 0) return;

  await q.add(
    "analyze",
    {
      network: event.network,
      contractAddress: event.contractAddress,
      creatorAddress: event.creatorAddress,
      txHash: event.txHash,
      blockNumber: event.blockNumber.toString(),
      input: event.input,
      tokenIds: event.tokenIds,
    },
    {
      // BullMQ rejects custom job ids containing ":" (its own key separator).
      jobId: `${event.network}-${event.contractAddress.toLowerCase()}`,
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
  /** Set when this is a re-check that found more than the first alert showed. */
  update?: boolean;
}

/**
 * Re-analyzes a contract that had no Token B yet: proxies and configurable
 * migrators usually get their tokens in an initialize()/setToken() call a
 * few transactions after the deploy. Re-alerts when Token B shows up or the
 * confidence level rises; keeps re-checking on the RECHECK_DELAYS_SEC
 * schedule until Token B is found.
 */
async function handleRecheck(data: RecheckJobData, onAnalyzed: (result: AnalyzedMigration) => Promise<void>) {
  const previous = await migrationContractRepository.findByContract(data.network, data.contractAddress);
  if (!previous || previous.tokenBAddress) return;
  const token = await tokenRepository.findById(previous.tokenId);
  if (!token) return;

  const analysis = await analyzeMigrationContract(data.network, data.contractAddress, data.input, [token.address]);
  const outcome = recheckOutcome(previous, analysis);
  logger.info(
    { network: data.network, contractAddress: data.contractAddress, attempt: data.attempt, outcome },
    "Re-checked contract detected without Token B",
  );

  if (outcome !== "unchanged") {
    const updated = await migrationContractRepository.updateAnalysis(previous.id, analysis);
    if (updated && outcome === "notify") await onAnalyzed({ token, migrationContract: updated, update: true });
  }
  if (!analysis.tokenBAddress) {
    await scheduleRecheck({ network: data.network, contractAddress: data.contractAddress, input: data.input }, data.attempt + 1);
  }
}

export function startContractCreationWorker(onAnalyzed: (result: AnalyzedMigration) => Promise<void>): Worker {
  const worker = new Worker<JobData>(
    QUEUE_NAME,
    async (job: Job<JobData>) => {
      if (job.name === "recheck") {
        await handleRecheck(job.data as RecheckJobData, onAnalyzed);
        return;
      }
      const data = job.data as ContractCreationJobData;

      const alreadySeen = await migrationContractRepository.alreadySeen(data.network, data.contractAddress);
      if (alreadySeen) {
        logger.debug({ data }, "Contract already analyzed, skipping");
        return;
      }

      // A deployment maps to one migration_contracts row, so when the creator
      // owns several tracked tokens the analyzer attributes it to the one the
      // contract references; same-network tokens are the fallback.
      const tokenIds = data.tokenIds ?? (data.tokenId !== undefined ? [data.tokenId] : []);
      const candidates = (await Promise.all(tokenIds.map((id) => tokenRepository.findById(id))))
        .filter((t): t is TokenRecord => t !== null)
        .sort((x, y) => Number(y.network === data.network) - Number(x.network === data.network));
      if (candidates.length === 0) {
        logger.warn({ tokenIds }, "Tokens no longer tracked, dropping job");
        return;
      }

      const analysis = await analyzeMigrationContract(
        data.network,
        data.contractAddress,
        data.input,
        candidates.map((t) => t.address),
      );
      const token =
        candidates.find((t) => analysis.tokenAAddress && t.address.toLowerCase() === analysis.tokenAAddress.toLowerCase()) ??
        candidates[0]!;

      const migrationContract = await migrationContractRepository.create({
        tokenId: token.id,
        network: data.network,
        contractAddress: data.contractAddress,
        creatorAddress: data.creatorAddress,
        tokenBAddress: analysis.tokenBAddress,
        confidence: analysis.confidence,
        confidenceScore: analysis.confidenceScore,
        matchedFunctions: analysis.matchedFunctions,
        matchedEvents: analysis.matchedEvents,
        matchedAuxiliary: analysis.matchedAuxiliary,
        tokenBSource: analysis.tokenBSource,
        matchedGetter: analysis.matchedGetter,
        txHash: data.txHash,
        blockNumber: BigInt(data.blockNumber),
      });

      if (!migrationContract) {
        logger.debug({ data }, "Duplicate insert race, skipping notification");
        return;
      }

      await onAnalyzed({ token, migrationContract });

      if (!migrationContract.tokenBAddress) {
        await scheduleRecheck({ network: data.network, contractAddress: data.contractAddress, input: data.input }, 0);
      }
    },
    { connection: createRedisConnection(), concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "Contract creation analysis job failed");
  });

  return worker;
}
