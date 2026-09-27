import { getAddress, type Address, type PublicClient } from "viem";
import type { NetworkKey } from "../types/index.js";
import { logger } from "../utils/logger.js";

export interface TracedCreate {
  address: Address;
  input: `0x${string}`;
}

interface CallFrame {
  type: string;
  from?: string;
  to?: string;
  input?: string;
  error?: string;
  calls?: CallFrame[];
}

function collectCreates(frame: CallFrame, out: TracedCreate[]): void {
  if ((frame.type === "CREATE" || frame.type === "CREATE2") && frame.to && !frame.error) {
    out.push({ address: getAddress(frame.to), input: (frame.input ?? "0x") as `0x${string}` });
  }
  for (const child of frame.calls ?? []) {
    collectCreates(child, out);
  }
}

// RPC error codes meaning "this endpoint doesn't offer the method at all".
const UNSUPPORTED_CODES = new Set([-32601, -32004]);
const MAX_CONSECUTIVE_FAILURES = 3;
// A disabled network is probed again after this long (plans and nodes change).
const DISABLE_FOR_MS = 6 * 60 * 60 * 1000;

const consecutiveFailures = new Map<NetworkKey, number>();
const disabledUntil = new Map<NetworkKey, number>();

function isUnsupportedMethod(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === "number" && UNSUPPORTED_CODES.has(e.code)) return true;
  }
  return false;
}

export type TraceStatus = "on" | "unavailable";

export function traceDetectionStatus(network: NetworkKey): TraceStatus {
  return (disabledUntil.get(network) ?? 0) > Date.now() ? "unavailable" : "on";
}

/**
 * Finds contracts created via an *internal* CREATE/CREATE2 inside a
 * transaction — i.e. deployed through a factory the tracked owner called,
 * rather than a direct EOA deployment (which the block listener already
 * catches via `tx.to === null`).
 *
 * Requires the RPC endpoint to expose `debug_traceTransaction` with the
 * `callTracer` (standard on Geth/Erigon-based nodes and most paid RPC
 * providers, but not on every public endpoint). A "method not supported"
 * answer, or three failures in a row, disables tracing for that network for
 * a few hours; a single transient failure is thrown instead, so the block
 * listener retries the block rather than silently missing a deployment.
 */
export async function findFactoryCreatedContracts(
  client: PublicClient,
  network: NetworkKey,
  txHash: `0x${string}`,
): Promise<TracedCreate[]> {
  if (traceDetectionStatus(network) === "unavailable") return [];

  try {
    // debug_traceTransaction isn't part of viem's typed public actions, so
    // the request is made through the untyped escape hatch.
    const request = client.request as unknown as (args: {
      method: "debug_traceTransaction";
      params: [`0x${string}`, { tracer: string }];
    }) => Promise<CallFrame>;

    const trace = await request({
      method: "debug_traceTransaction",
      params: [txHash, { tracer: "callTracer" }],
    });

    consecutiveFailures.delete(network);
    const out: TracedCreate[] = [];
    collectCreates(trace, out);
    return out;
  } catch (err) {
    const failures = (consecutiveFailures.get(network) ?? 0) + 1;
    consecutiveFailures.set(network, failures);
    if (!isUnsupportedMethod(err) && failures < MAX_CONSECUTIVE_FAILURES) throw err;

    consecutiveFailures.delete(network);
    disabledUntil.set(network, Date.now() + DISABLE_FOR_MS);
    logger.warn(
      { err, network },
      "debug_traceTransaction unavailable on this RPC — factory/CREATE2 detection paused for this network for 6h",
    );
    return [];
  }
}

// --- whole-block tracing (auto-discovery) -----------------------------------------

export interface BlockCreate {
  address: Address;
  input: `0x${string}`;
  txHash: `0x${string}`;
}

type BlockTraceMethod = "debug_traceBlockByNumber" | "trace_block";
// Per network: the tracing method that worked, and when a network with
// neither was last given up on.
const blockTraceMethod = new Map<NetworkKey, BlockTraceMethod>();
const blockTracePausedUntil = new Map<NetworkKey, number>();

export function blockTraceStatus(network: NetworkKey): "on" | "unavailable" | "untested" {
  if ((blockTracePausedUntil.get(network) ?? 0) > Date.now()) return "unavailable";
  return blockTraceMethod.has(network) ? "on" : "untested";
}

interface ParityTrace {
  type: string;
  transactionHash?: string;
  action?: { init?: string };
  result?: { address?: string } | null;
  error?: string;
}

async function traceWith(
  client: PublicClient,
  method: BlockTraceMethod,
  blockNumber: bigint,
): Promise<BlockCreate[]> {
  const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  const blockHex = `0x${blockNumber.toString(16)}`;
  const out: BlockCreate[] = [];

  if (method === "debug_traceBlockByNumber") {
    const results = (await request({ method, params: [blockHex, { tracer: "callTracer" }] })) as Array<{
      txHash?: string;
      result?: CallFrame;
    }>;
    for (const { txHash, result } of results ?? []) {
      if (!result || !txHash) continue;
      const creates: TracedCreate[] = [];
      collectCreates(result, creates);
      for (const c of creates) out.push({ ...c, txHash: txHash as `0x${string}` });
    }
  } else {
    const traces = (await request({ method, params: [blockHex] })) as ParityTrace[];
    for (const t of traces ?? []) {
      if (t.type !== "create" || t.error || !t.result?.address || !t.transactionHash) continue;
      out.push({
        address: getAddress(t.result.address),
        input: (t.action?.init ?? "0x") as `0x${string}`,
        txHash: t.transactionHash as `0x${string}`,
      });
    }
  }
  return out;
}

const blockTraceFailures = new Map<NetworkKey, number>();

/**
 * Every contract created in a block — by EOAs and inside factories
 * (CREATE/CREATE2) — from one trace call. Uses Geth's
 * debug_traceBlockByNumber or Parity/Erigon's trace_block, whichever the
 * endpoint offers. Never throws: on failure it returns null and the caller
 * still handles direct deployments from the block itself. "Method not
 * supported", or three failed blocks in a row, pauses tracing for 6h.
 */
export async function findBlockCreates(
  client: PublicClient,
  network: NetworkKey,
  blockNumber: bigint,
): Promise<BlockCreate[] | null> {
  if (blockTraceStatus(network) === "unavailable") return null;

  const known = blockTraceMethod.get(network);
  const methods: BlockTraceMethod[] = known ? [known] : ["debug_traceBlockByNumber", "trace_block"];
  let lastError: unknown;
  let allUnsupported = true;
  for (const method of methods) {
    try {
      const creates = await traceWith(client, method, blockNumber);
      blockTraceMethod.set(network, method);
      blockTraceFailures.delete(network);
      return creates;
    } catch (err) {
      lastError = err;
      if (!isUnsupportedMethod(err)) allUnsupported = false;
    }
  }

  const failures = (blockTraceFailures.get(network) ?? 0) + 1;
  blockTraceFailures.set(network, failures);
  if (allUnsupported || failures >= MAX_CONSECUTIVE_FAILURES) {
    blockTraceMethod.delete(network);
    blockTraceFailures.delete(network);
    blockTracePausedUntil.set(network, Date.now() + DISABLE_FOR_MS);
    logger.warn(
      { err: lastError, network },
      "Block tracing (debug_traceBlockByNumber / trace_block) unavailable — factory deployments are not auto-discovered on this network for 6h",
    );
  } else {
    logger.warn({ err: lastError, network, blockNumber: blockNumber.toString() }, "Block trace failed; factory deployments in this block may be missed");
  }
  return null;
}
