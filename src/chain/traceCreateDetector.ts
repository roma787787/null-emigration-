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

// Networks whose RPC endpoint doesn't expose debug_traceTransaction (or errored
// on first attempt) — skipped for the rest of the process's lifetime instead
// of retrying every matching tx.
const unsupportedNetworks = new Set<NetworkKey>();

/**
 * Finds contracts created via an *internal* CREATE/CREATE2 inside a
 * transaction — i.e. deployed through a factory the tracked owner called,
 * rather than a direct EOA deployment (which the block listener already
 * catches via `tx.to === null`).
 *
 * Requires the RPC endpoint to expose `debug_traceTransaction` with the
 * `callTracer` (standard on Geth/Erigon-based nodes and most paid RPC
 * providers, but not on every public endpoint). The first failure disables
 * tracing for that network rather than erroring on every subsequent call.
 */
export async function findFactoryCreatedContracts(
  client: PublicClient,
  network: NetworkKey,
  txHash: `0x${string}`,
): Promise<TracedCreate[]> {
  if (unsupportedNetworks.has(network)) return [];

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

    const out: TracedCreate[] = [];
    collectCreates(trace, out);
    return out;
  } catch (err) {
    unsupportedNetworks.add(network);
    logger.warn(
      { err, network },
      "debug_traceTransaction unavailable on this RPC — disabling factory/CREATE2 detection for this network",
    );
    return [];
  }
}
