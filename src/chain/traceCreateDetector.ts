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
