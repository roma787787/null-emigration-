import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redisClient.js";
import type { LiquidityLevel, MigrationContractRecord, NetworkKey, TokenRecord } from "../types/index.js";
import { analyzeMigrationContract } from "../analyzer/migrationAnalyzer.js";
import { migrationContractRepository } from "../db/repositories/migrationContractRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import { recheckOutcome } from "../analyzer/recheck.js";
import { env } from "../config/env.js";
import type { TrackedContractCreationEvent, UntrackedContractCreationEvent } from "../chain/blockListener.js";
import { analyzeAutoCandidate } from "../analyzer/autoAnalyzer.js";
import { checkLiquidityLevels, isOkxConfigured, type LiquidityCheck } from "../liquidity/okxLiquidity.js";
import { noteAutoAlert, noteCandidate, noteLiquiditySkip, noteSkipped } from "../chain/autoStats.js";
import { getPublicClient } from "../chain/provider.js";
import { readTokenSymbol } from "../chain/tokenMetadata.js";
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
  /** The tracked token it belongs to; null for auto-discovered contracts (Token A is on the record). */
  token: TokenRecord | null;
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
  const token = previous.tokenId !== null ? await tokenRepository.findById(previous.tokenId) : null;
  const tokenA = token?.address ?? previous.tokenAAddress;
  if (!tokenA) return;

  const analysis = await analyzeMigrationContract(data.network, data.contractAddress, data.input, [tokenA]);
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
        discovery: "tracked",
        tokenAAddress: token.address,
        tokenASymbol: token.symbol,
        tokenBSymbolUnverified: analysis.tokenBSymbolUnverified,
        rwaSignals: analysis.rwaSignals,
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

// --- auto-discovery ----------------------------------------------------------------

const AUTO_QUEUE_NAME = "auto-discovery";

export interface AutoJobData {
  network: NetworkKey;
  contractAddress: `0x${string}`;
  creatorAddress: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: string;
  input: `0x${string}`;
  custodianLabel: string | null;
}

let autoQueue: Queue<AutoJobData> | undefined;

export function getAutoDiscoveryQueue(): Queue<AutoJobData> {
  if (!autoQueue) autoQueue = new Queue<AutoJobData>(AUTO_QUEUE_NAME, { connection: createRedisConnection() });
  return autoQueue;
}

export async function enqueueAutoCandidate(event: UntrackedContractCreationEvent): Promise<void> {
  await getAutoDiscoveryQueue().add(
    "auto",
    {
      network: event.network,
      contractAddress: event.contractAddress,
      creatorAddress: event.creatorAddress,
      txHash: event.txHash,
      blockNumber: event.blockNumber.toString(),
      input: event.input,
      custodianLabel: event.custodianLabel,
    },
    {
      jobId: `${event.network}-${event.contractAddress.toLowerCase()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3_000 },
      removeOnComplete: 5000,
      removeOnFail: 1000,
    },
  );
}

const STATUS_RANK = { pass: 2, unchecked: 1, skip: 0 } as const;

/** Whether `alt` makes a more plausible old token than `current`: routes where the other doesn't, or with less price impact. */
function moreLiquid(alt: Record<LiquidityLevel, LiquidityCheck>, current: Record<LiquidityLevel, LiquidityCheck>): boolean {
  const a = alt.LOW_CAP, c = current.LOW_CAP;
  if (STATUS_RANK[a.status] !== STATUS_RANK[c.status]) return STATUS_RANK[a.status] > STATUS_RANK[c.status];
  return a.status === "pass" && (a.impactPercent ?? Infinity) < (c.impactPercent ?? Infinity);
}

/**
 * Spec workflow for any new contract: migration signatures → Token A by
 * address → OKX executable-route test on Token A → alert. Contracts from a
 * registered RWA custodian skip the DEX test (tokenized stocks trade off-DEX).
 */
export function startAutoDiscoveryWorker(onAnalyzed: (result: AnalyzedMigration) => Promise<void>): Worker {
  const worker = new Worker<AutoJobData>(
    AUTO_QUEUE_NAME,
    async (job) => {
      const data = job.data;
      if (await migrationContractRepository.alreadySeen(data.network, data.contractAddress)) return;

      const outcome = await analyzeAutoCandidate(data.network, data.contractAddress, data.input);
      if (outcome.kind === "skipped") {
        noteSkipped(data.network, outcome.reason);
        return;
      }
      noteCandidate(data.network);
      let result = outcome.result;

      let liquidity: Record<LiquidityLevel, LiquidityCheck> | null = null;
      if (!data.custodianLabel) {
        liquidity = await checkLiquidityLevels(data.network, result.tokenAAddress);
        // Names didn't say which token is the old one: the one with a real
        // market is (a brand-new token has none yet).
        if (result.alternateTokenA) {
          const alt = await checkLiquidityLevels(data.network, result.alternateTokenA);
          if (moreLiquid(alt, liquidity)) {
            const client = getPublicClient(data.network);
            result = {
              ...result,
              tokenAAddress: result.alternateTokenA,
              tokenASymbol: await readTokenSymbol(client, result.alternateTokenA),
              tokenBAddress: result.tokenAAddress,
              tokenBSource: result.tokenAGetter === "constructor" ? "constructor_args" : "static_call",
              matchedGetter: result.tokenAGetter === "constructor" ? null : result.tokenAGetter,
            };
            liquidity = alt;
          }
        }
        const failed = liquidity.LOW_CAP.status === "unchecked" && isOkxConfigured();
        if (failed && job.attemptsMade < 2) throw new Error(`OKX check failed, retrying: ${liquidity.LOW_CAP.reason}`);
        if (liquidity.LOW_CAP.status === "skip") {
          noteLiquiditySkip(data.network);
          logger.debug({ data, reason: liquidity.LOW_CAP.reason }, "Auto candidate dropped by liquidity filter");
          return;
        }
      }

      const { alternateTokenA: _alt, tokenAGetter: _getter, ...fields } = result;
      const migrationContract = await migrationContractRepository.create({
        ...fields,
        tokenId: null,
        discovery: data.custodianLabel ? "custodian" : "auto",
        liquidity,
        custodianLabel: data.custodianLabel,
        network: data.network,
        contractAddress: data.contractAddress,
        creatorAddress: data.creatorAddress,
        txHash: data.txHash,
        blockNumber: BigInt(data.blockNumber),
      });
      if (!migrationContract) return;

      noteAutoAlert(data.network);
      await onAnalyzed({ token: null, migrationContract });

      if (!migrationContract.tokenBAddress) {
        await scheduleRecheck({ network: data.network, contractAddress: data.contractAddress, input: data.input }, 0);
      }
    },
    { connection: createRedisConnection(), concurrency: env.AUTO_CONCURRENCY },
  );

  worker.on("failed", (job, err) => {
    logger.warn({ err, jobId: job?.id }, "Auto-discovery job failed");
  });
  return worker;
}
