import type { NetworkKey } from "../types/index.js";

export interface WatchPlanInput {
  /** ENABLED_NETWORKS, resolved: each gets a block listener. */
  enabled: NetworkKey[];
  autoOn: boolean;
  /** AUTO_DISCOVERY_NETWORKS; empty = every enabled network. */
  autoList: string[];
  /** CUSTODIAN_NETWORKS, known networks only. */
  custodianList: NetworkKey[];
  custodianWatch: boolean;
}

export interface WatchPlan {
  /** Enabled networks whose every block auto-discovery reads. */
  auto: NetworkKey[];
  /** Networks where only RWA custodians' deployments are watched (no block feed). */
  custodians: NetworkKey[];
}

/**
 * Which networks get what. Auto-discovery only ever runs on enabled
 * networks (an empty AUTO_DISCOVERY_NETWORKS means all of *those*), and
 * custodians are watched wherever it doesn't already read every block:
 * enabled networks without it, plus CUSTODIAN_NETWORKS.
 */
export function planWatch(input: WatchPlanInput): WatchPlan {
  const auto = input.autoOn
    ? input.enabled.filter((n) => input.autoList.length === 0 || input.autoList.includes(n))
    : [];
  const custodians = input.custodianWatch
    ? [...new Set([...input.enabled, ...input.custodianList])].filter((n) => !auto.includes(n))
    : [];
  return { auto, custodians };
}
