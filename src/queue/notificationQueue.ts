import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redisClient.js";
import type { LiquidityLevel, MigrationContractRecord, NetworkKey, TokenRecord } from "../types/index.js";
import { analyzeMigrationContract } from "../analyzer/migrationAnalyzer.js";
import { migrationContractRepository } from "../db/repositories/migrationContractRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import { recheckOutcome } from "../analyzer/recheck.js";
import { env } from "../config/env.js";
import type { TrackedContractCreationEvent, UntrackedContractCreationEvent } from "../chain/blockListener.js";
import { analyzeAutoCandidate, sourceOf, type AutoAnalysisResult } from "../analyzer/autoAnalyzer.js";
import { alreadyAlerted, dedupKeys, firstListing, markAlerted } from "./autoDedup.js";
import { readListing, type RwaListing } from "../rwa/listings.js";
import { checkLiquidityLevels, isOkxConfigured, type LiquidityCheck } from "../liquidity/okxLiquidity.js";
import { noteAutoAlert, noteCandidate, noteLiquiditySkip, noteSkipped } from "../chain/autoStats.js";
import { getPublicClient } from "../chain/provider.js";
import { readTokenSymbol } from "../chain/tokenMetadata.js";
import { logger } from "../utils/logger.js";
import { findDeployBlock } from "../chain/creationLookup.js";
import { isAddressEqual, type Address } from "viem";

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
  /** For "auto-recheck" jobs: index into RECHECK_DELAYS_SEC. */
  attempt?: number;
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

/** Looks at a not-yet-configured contract again later (tokens / implementation set after deploy). */
async function scheduleAutoRecheck(data: AutoJobData, attempt: number): Promise<void> {
  const delaySec = env.RECHECK_DELAYS_SEC[attempt];
  if (delaySec === undefined) return;
  await getAutoDiscoveryQueue().add(
    "auto-recheck",
    { ...data, attempt },
    {
      jobId: `${data.network}-${data.contractAddress.toLowerCase()}-autorecheck-${attempt}`,
      delay: delaySec * 1000,
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

// When a token was deployed never changes: cached per network + address.
const deployBlocks = new Map<string, bigint | null>();

async function deployBlockOf(network: NetworkKey, token: Address, head: bigint): Promise<bigint | null> {
  const key = `${network}:${token.toLowerCase()}`;
  if (!deployBlocks.has(key)) deployBlocks.set(key, await findDeployBlock(getPublicClient(network), token, head));
  return deployBlocks.get(key)!;
}

/**
 * Of two tokens, the one deployed first — the old one of a migration, even
 * when the new one already trades deeper (a project listing its new token
 * before the migration opens: Telcoin's TEL v3 on Base). Null when it can't
 * be told (same block, or an RPC without history).
 */
export async function olderToken(network: NetworkKey, a: Address, b: Address): Promise<Address | null> {
  try {
    const head = await getPublicClient(network).getBlockNumber();
    const [blockA, blockB] = await Promise.all([deployBlockOf(network, a, head), deployBlockOf(network, b, head)]);
    if (blockA === null || blockB === null || blockA === blockB) return null;
    return blockA < blockB ? a : b;
  } catch (err) {
    logger.warn({ err, network, a, b }, "Could not tell which token is older");
    return null;
  }
}

export type LiquidityDecision =
  /** Alertable: Token A trades (or a custodian's contract, which skips the DEX test: liquidity null). */
  | { kind: "pass"; result: AutoAnalysisResult; liquidity: Record<LiquidityLevel, LiquidityCheck> | null }
  /** OKX could not answer; the worker retries before sending it unchecked. */
  | { kind: "unchecked"; result: AutoAnalysisResult; liquidity: Record<LiquidityLevel, LiquidityCheck> }
  | {
      kind: "drop";
      reason: "liquidity" | "swap between two traded tokens" | "stablecoin converter";
      result: AutoAnalysisResult;
      liquidity: Record<LiquidityLevel, LiquidityCheck> | null;
    };

const DECIMALS_ABI = [{ type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }] as const;

/**
 * Whether the test swap priced `token` at about one dollar (the $300 buys
 * 291–309 tokens): a stablecoin. A contract converting one dollar token into
 * another (RLUSD → PYUSD, crvUSD ↔ reUSD) is a stablecoin converter, not a
 * migration — and needs no list of stablecoins per chain.
 */
export async function pricedAsDollar(network: NetworkKey, token: `0x${string}`, check: LiquidityCheck): Promise<boolean> {
  if (check.status !== "pass" || !check.amountOut) return false;
  const decimals = await getPublicClient(network)
    .readContract({ address: token, abi: DECIMALS_ABI, functionName: "decimals" })
    .catch(() => null);
  if (decimals === null) return false;
  const tokens = Number(BigInt(check.amountOut) * 1000n / 10n ** BigInt(decimals)) / 1000;
  const perDollar = tokens / check.amountUsd;
  return perDollar >= 0.97 && perDollar <= 1.03;
}

/**
 * The OKX part of the spec workflow for a candidate, shared by the live
 * worker and the history backfill: which token is the old one when names
 * didn't say, whether a bare swap(amount) is a bot, and whether Token A
 * has an executable route.
 */
export async function applyLiquidityRules(
  network: NetworkKey,
  analyzed: AutoAnalysisResult,
  custodianLabel: string | null,
): Promise<LiquidityDecision> {
  let result = analyzed;
  if (custodianLabel) return { kind: "pass", result, liquidity: null };

  let liquidity = await checkLiquidityLevels(network, result.tokenAAddress);
  // Names didn't say which token is the old one: the one with a real
  // market is (a brand-new token has none yet). When both trade, the one
  // deployed first is — the new one may already trade deeper.
  if (result.alternateTokenA) {
    const alternate = result.alternateTokenA;
    const alt = await checkLiquidityLevels(network, alternate);
    const bothTrade = alt.LOW_CAP.status === "pass" && liquidity.LOW_CAP.status === "pass";
    const older = bothTrade ? await olderToken(network, result.tokenAAddress, alternate) : null;
    if (older ? isAddressEqual(older, alternate) : moreLiquid(alt, liquidity)) {
      const client = getPublicClient(network);
      result = {
        ...result,
        tokenAAddress: result.alternateTokenA,
        tokenASymbol: await readTokenSymbol(client, result.alternateTokenA),
        tokenBAddress: result.tokenAAddress,
        tokenBSource: sourceOf(result.tokenAGetter),
        matchedGetter: sourceOf(result.tokenAGetter) === "static_call" ? result.tokenAGetter : null,
      };
      liquidity = alt;
    }
  }
  // Only a bare swap(amount) got it here: a migration's Token B is new
  // and has no market yet; two traded tokens mean a bot or a zap.
  if (result.swapOnly && result.tokenBAddress) {
    const target = await checkLiquidityLevels(network, result.tokenBAddress);
    if (target.LOW_CAP.status === "pass") return { kind: "drop", reason: "swap between two traded tokens", result, liquidity };
  }
  if (liquidity.LOW_CAP.status === "unchecked" && isOkxConfigured()) return { kind: "unchecked", result, liquidity };
  if (liquidity.LOW_CAP.status === "skip") return { kind: "drop", reason: "liquidity", result, liquidity };
  if (await pricedAsDollar(network, result.tokenAAddress, liquidity.LOW_CAP)) {
    return { kind: "drop", reason: "stablecoin converter", result, liquidity };
  }
  return { kind: "pass", result, liquidity };
}

/**
 * Spec workflow for any new contract: migration signatures → Token A by
 * address → OKX executable-route test on Token A → alert. Contracts from a
 * registered RWA custodian skip the DEX test (tokenized stocks trade off-DEX).
 */
export function startAutoDiscoveryWorker(
  onAnalyzed: (result: AnalyzedMigration) => Promise<void>,
  /** A registered custodian's new token that is not a migration (a new stock token listing). */
  onListing?: (listing: RwaListing) => void,
): Worker {
  const worker = new Worker<AutoJobData>(
    AUTO_QUEUE_NAME,
    async (job) => {
      const data = job.data;
      if (await migrationContractRepository.alreadySeen(data.network, data.contractAddress)) return;

      const outcome = await analyzeAutoCandidate(data.network, data.contractAddress, data.input);
      if (outcome.kind === "skipped") {
        noteSkipped(data.network, outcome.reason);
        if (data.custodianLabel && onListing) {
          const listing = await readListing(data.network, data.contractAddress, data.custodianLabel).catch((err) => {
            logger.warn({ err, network: data.network, contractAddress: data.contractAddress }, "Reading a custodian token failed");
            return null;
          });
          if (listing && (await firstListing(data.network, listing.address))) onListing(listing);
        }
        if (outcome.recheck) await scheduleAutoRecheck(data, job.name === "auto-recheck" ? (data.attempt ?? 0) + 1 : 0);
        return;
      }
      let result = outcome.result;
      // The same token pair, or the same code (clones, bot fleets), alerts once per AUTO_DEDUP_HOURS.
      const keys = dedupKeys(data.network, result.tokenAAddress, result.tokenBAddress ?? result.tokenBSymbolUnverified, result.codeHash);
      if (await alreadyAlerted(keys)) {
        noteSkipped(data.network, "duplicate");
        return;
      }
      noteCandidate(data.network);

      const decision = await applyLiquidityRules(data.network, result, data.custodianLabel);
      if (decision.kind === "drop") {
        if (decision.reason === "liquidity") {
          noteLiquiditySkip(data.network);
          logger.debug({ data, reason: decision.liquidity?.LOW_CAP.reason }, "Auto candidate dropped by liquidity filter");
        } else {
          noteSkipped(data.network, decision.reason);
        }
        return;
      }
      if (decision.kind === "unchecked" && job.attemptsMade < 2) {
        throw new Error(`OKX check failed, retrying: ${decision.liquidity.LOW_CAP.reason}`);
      }
      result = decision.result;
      const liquidity = decision.liquidity;
      // Only now is it an alert: the keys are taken (a concurrent twin loses).
      if (!(await markAlerted(keys))) {
        noteSkipped(data.network, "duplicate");
        return;
      }

      const { alternateTokenA: _alt, tokenAGetter: _getter, codeHash: _code, swapOnly: _swapOnly, ...fields } = result;
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
