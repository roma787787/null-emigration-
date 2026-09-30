import type { NetworkKey } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { collectBlockCreations, type UntrackedContractCreationEvent } from "../chain/blockListener.js";
import { analyzeAutoCandidate, type AutoAnalysisResult } from "../analyzer/autoAnalyzer.js";
import { applyLiquidityRules } from "../queue/notificationQueue.js";
import { dedupKeys } from "../queue/autoDedup.js";
import { getNetwork } from "../config/networks.js";
import type { LiquidityCheck } from "../liquidity/okxLiquidity.js";
import { logger } from "../utils/logger.js";

/**
 * History backfill: runs past blocks through the live pipeline — the same
 * contract discovery, analysis, filters and OKX test — and reports what the
 * bot would have alerted and why everything else was dropped. Nothing is
 * sent to chats, stored as a detection, or counted in /status.
 */

export type BackfillDecision = "alert" | "liquidity" | "swap-bot" | "stablecoin" | "unchecked" | "duplicate";

export interface BackfillCandidate {
  blockNumber: bigint;
  contractAddress: string;
  creatorAddress: string;
  decision: BackfillDecision;
  tokenAAddress: string;
  tokenASymbol: string | null;
  tokenBAddress: string | null;
  tokenBSymbolUnverified: string | null;
  confidence: string;
  confidenceScore: number;
  functions: string[];
  custodianLabel: string | null;
  liquidity: Partial<Record<"LOW_CAP" | "STRICT" | "DEEP", LiquidityCheck>> | null;
  /** The earlier candidate with the same token pair or the same code. */
  duplicateOf: string | null;
}

export interface BackfillReport {
  network: NetworkKey;
  fromBlock: bigint;
  toBlock: bigint;
  blocksScanned: number;
  blocksFailed: number;
  contracts: number;
  analysisErrors: number;
  /** Why the non-candidates were dropped, e.g. { "no migration signature": 51234, "liquidity pool": 310 }. */
  skipped: Record<string, number>;
  candidates: BackfillCandidate[];
  startedAt: Date;
  finishedAt: Date | null;
  stopped: boolean;
}

export interface BackfillProgress {
  done: number;
  total: number;
  report: BackfillReport;
}

export interface BackfillOptions {
  network: NetworkKey;
  fromBlock: bigint;
  toBlock: bigint;
  /** Pace, so the live bot keeps its RPC share (block traces are the heavy calls). */
  blocksPerSec?: number;
  /** Blocks fetched at once (the pace above still caps the average rate). */
  parallelBlocks?: number;
  /** Contracts analyzed at once. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BackfillProgress) => void | Promise<void>;
  /** Progress is reported each time this share of blocks is done (0.25 = at 25/50/75%). */
  progressStep?: number;
}

const BLOCK_RETRIES = [1_000, 4_000, 10_000];

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = BLOCK_RETRIES[attempt];
      if (delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** The first block mined at or after `timestampSec` (bisection over block timestamps). */
export async function blockAtTime(network: NetworkKey, timestampSec: number): Promise<bigint> {
  const client = getPublicClient(network);
  const head = await client.getBlock();
  if (Number(head.timestamp) <= timestampSec) return head.number;
  let lo = 0n;
  let hi = head.number;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < timestampSec) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Runs `fn` over `items`, at most `limit` at a time; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const { network, fromBlock, toBlock, signal } = options;
  const blocksPerSec = options.blocksPerSec ?? 10;
  const parallelBlocks = Math.max(1, Math.floor(options.parallelBlocks ?? 8));
  const concurrency = options.concurrency ?? 8;
  const step = options.progressStep ?? 0.25;
  const report: BackfillReport = {
    network,
    fromBlock,
    toBlock,
    blocksScanned: 0,
    blocksFailed: 0,
    contracts: 0,
    analysisErrors: 0,
    skipped: {},
    candidates: [],
    startedAt: new Date(),
    finishedAt: null,
    stopped: false,
  };
  const total = Number(toBlock - fromBlock + 1n);
  const seenKeys = new Map<string, string>();
  const skip = (reason: string) => (report.skipped[reason] = (report.skipped[reason] ?? 0) + 1);
  let nextReport = step;

  // Decided one at a time, in block order: whether a candidate is a duplicate
  // depends on what was alerted before it.
  const decide = async (event: UntrackedContractCreationEvent, found: AutoAnalysisResult) => {
    // As live: a duplicate is a repeat of something already ALERTED (same pair or same code).
    const keys = dedupKeys(network, found.tokenAAddress, found.tokenBAddress ?? found.tokenBSymbolUnverified, found.codeHash);
    const duplicateOf = keys.map((k) => seenKeys.get(k)).find((a) => a !== undefined) ?? null;

    let decision: BackfillDecision = "duplicate";
    let result = found;
    let liquidity: BackfillCandidate["liquidity"] = null;
    if (!duplicateOf) {
      const verdict = await applyLiquidityRules(network, found, event.custodianLabel);
      result = verdict.result;
      liquidity = verdict.liquidity;
      decision =
        verdict.kind === "pass" ? "alert"
        : verdict.kind === "unchecked" ? "unchecked"
        : verdict.reason === "liquidity" ? "liquidity"
        : verdict.reason === "stablecoin converter" ? "stablecoin"
        : "swap-bot";
      if (decision === "alert" || decision === "unchecked") {
        for (const k of keys) if (!seenKeys.has(k)) seenKeys.set(k, event.contractAddress);
      }
    }
    report.candidates.push({
      blockNumber: event.blockNumber,
      contractAddress: event.contractAddress,
      creatorAddress: event.creatorAddress,
      decision,
      tokenAAddress: result.tokenAAddress,
      tokenASymbol: result.tokenASymbol,
      tokenBAddress: result.tokenBAddress,
      tokenBSymbolUnverified: result.tokenBSymbolUnverified,
      confidence: result.confidence,
      confidenceScore: result.confidenceScore,
      functions: result.matchedFunctions,
      custodianLabel: event.custodianLabel,
      liquidity,
      duplicateOf,
    });
  };

  const started = Date.now();
  for (let first = fromBlock; first <= toBlock; first += BigInt(parallelBlocks)) {
    if (signal?.aborted) {
      report.stopped = true;
      break;
    }
    // Pace: block k is not started before k / blocksPerSec seconds in.
    const due = started + (Number(first - fromBlock) * 1000) / blocksPerSec;
    if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));

    const blocks: bigint[] = [];
    for (let b = first; b <= toBlock && blocks.length < parallelBlocks; b++) blocks.push(b);

    // 1. The window's blocks, fetched at once.
    const fetched = await Promise.all(
      blocks.map((block) =>
        withRetry(() => collectBlockCreations(network, block)).catch((err) => {
          report.blocksFailed++;
          logger.warn({ err, network, block: block.toString() }, "Backfill: block failed after retries");
          return [] as UntrackedContractCreationEvent[];
        }),
      ),
    );
    const events = fetched.flat();
    report.contracts += events.length;

    // 2. Every new contract of the window analyzed in parallel.
    const outcomes = await mapLimit(events, concurrency, (event) =>
      analyzeAutoCandidate(network, event.contractAddress, event.input).catch((err) => {
        report.analysisErrors++;
        logger.warn({ err, network, contractAddress: event.contractAddress }, "Backfill: analysis failed");
        return null;
      }),
    );

    // 3. Candidates decided in block order.
    for (let i = 0; i < events.length; i++) {
      const outcome = outcomes[i];
      if (!outcome) continue;
      if (outcome.kind === "skipped") {
        skip(outcome.reason);
        continue;
      }
      await decide(events[i]!, outcome.result).catch((err) => {
        report.analysisErrors++;
        logger.warn({ err, network, contractAddress: events[i]!.contractAddress }, "Backfill: liquidity check failed");
      });
    }

    report.blocksScanned += blocks.length;
    if (options.onProgress && report.blocksScanned / total >= nextReport && report.blocksScanned < total) {
      while (report.blocksScanned / total >= nextReport) nextReport += step;
      await options.onProgress({ done: report.blocksScanned, total, report });
    }
  }
  report.finishedAt = new Date();
  return report;
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const levelCell = (check: LiquidityCheck | undefined) =>
  !check ? "" : check.status === "pass" ? `pass ${check.impactPercent?.toFixed(2)}%` : `${check.status}: ${check.reason}`;

/** Every candidate, one row each, for a spreadsheet. */
export function backfillCsv(report: BackfillReport): string {
  const network = getNetwork(report.network);
  const header = [
    "block", "decision", "contract", "creator", "token_a", "token_a_symbol", "token_b", "token_b_ticker_only",
    "confidence", "score", "functions", "low_cap_300", "strict_1000", "deep_10000", "custodian", "duplicate_of", "explorer",
  ];
  const rows = report.candidates.map((c) =>
    [
      c.blockNumber, c.decision, c.contractAddress, c.creatorAddress, c.tokenAAddress, c.tokenASymbol, c.tokenBAddress,
      c.tokenBSymbolUnverified, c.confidence, c.confidenceScore, c.functions.join(" "), levelCell(c.liquidity?.LOW_CAP),
      levelCell(c.liquidity?.STRICT), levelCell(c.liquidity?.DEEP), c.custodianLabel, c.duplicateOf,
      network.explorerAddressUrl(c.contractAddress),
    ].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

/** Counts per decision, e.g. { alert: 3, liquidity: 41, duplicate: 12 }. */
export function decisionCounts(report: BackfillReport): Record<BackfillDecision, number> {
  const counts: Record<BackfillDecision, number> = { alert: 0, liquidity: 0, "swap-bot": 0, stablecoin: 0, unchecked: 0, duplicate: 0 };
  for (const c of report.candidates) counts[c.decision]++;
  return counts;
}
