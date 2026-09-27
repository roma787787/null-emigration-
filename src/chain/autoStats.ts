import type { NetworkKey } from "../types/index.js";

/** Auto-discovery counters since start, per network, for /status. */
export interface AutoStats {
  blocks: number;
  creations: number;
  candidates: number;
  liquiditySkipped: number;
  alerts: number;
  skipped: Record<string, number>;
}

const stats = new Map<NetworkKey, AutoStats>();

function of(network: NetworkKey): AutoStats {
  let s = stats.get(network);
  if (!s) {
    s = { blocks: 0, creations: 0, candidates: 0, liquiditySkipped: 0, alerts: 0, skipped: {} };
    stats.set(network, s);
  }
  return s;
}

export const noteBlockSeen = (network: NetworkKey) => void of(network).blocks++;
export const noteCreationSeen = (network: NetworkKey) => void of(network).creations++;
export const noteCandidate = (network: NetworkKey) => void of(network).candidates++;
export const noteLiquiditySkip = (network: NetworkKey) => void of(network).liquiditySkipped++;
export const noteAutoAlert = (network: NetworkKey) => void of(network).alerts++;
export function noteSkipped(network: NetworkKey, reason: string): void {
  const s = of(network);
  s.skipped[reason] = (s.skipped[reason] ?? 0) + 1;
}

export function autoStats(network: NetworkKey): AutoStats | undefined {
  return stats.get(network);
}

export function totalAutoStats(): AutoStats {
  const total: AutoStats = { blocks: 0, creations: 0, candidates: 0, liquiditySkipped: 0, alerts: 0, skipped: {} };
  for (const s of stats.values()) {
    total.blocks += s.blocks;
    total.creations += s.creations;
    total.candidates += s.candidates;
    total.liquiditySkipped += s.liquiditySkipped;
    total.alerts += s.alerts;
    for (const [k, v] of Object.entries(s.skipped)) total.skipped[k] = (total.skipped[k] ?? 0) + v;
  }
  return total;
}
