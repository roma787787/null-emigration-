import type { NetworkKey } from "../types/index.js";

/** Live per-network listener health, read by the admin /status command. */
export interface ListenerStatus {
  mode: "websocket" | "polling";
  startedAt: Date;
  lastProcessedBlock: bigint | null;
  lastProcessedAt: Date | null;
  /** Blocks older than MAX_CATCHUP_BLOCKS skipped after a long downtime. */
  skippedBlocks: number;
  /** Blocks abandoned after every retry failed. */
  failedBlocks: number;
  /** Times the watchdog found the block feed stalled and restarted it. */
  restarts: number;
  lastError: string | null;
  lastErrorAt: Date | null;
}

const statuses = new Map<NetworkKey, ListenerStatus>();

export function initListenerStatus(network: NetworkKey, mode: ListenerStatus["mode"]): ListenerStatus {
  const status: ListenerStatus = {
    mode,
    startedAt: new Date(),
    lastProcessedBlock: null,
    lastProcessedAt: null,
    skippedBlocks: 0,
    failedBlocks: 0,
    restarts: 0,
    lastError: null,
    lastErrorAt: null,
  };
  statuses.set(network, status);
  return status;
}

export function getListenerStatus(network: NetworkKey): ListenerStatus | undefined {
  return statuses.get(network);
}

export function recordListenerError(network: NetworkKey, err: unknown): void {
  const status = statuses.get(network);
  if (!status) return;
  status.lastError = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err);
  status.lastErrorAt = new Date();
}
