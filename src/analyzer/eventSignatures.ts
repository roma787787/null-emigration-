import { toEventSelector } from "viem";

/**
 * Event signatures migration contracts commonly emit (spec section 4.3.4).
 * Like the function selectors, several plausible argument shapes are listed
 * per event name since we have no ABI for the deployed contract — only the
 * exact 32-byte topic hash can be checked against the runtime bytecode.
 */
const MIGRATION_EVENT_SIGNATURES = [
  "Migrated(address,uint256)",
  "Migrated(address,address,uint256)",
  "Migrate(address,uint256)",
  "TokensSwapped(address,uint256)",
  "TokensSwapped(address,uint256,uint256)",
  "TokensSwapped(address,address,uint256)",
  "Swapped(address,uint256)",
  "Swap(address,uint256,uint256)",
  "Deposit(address,uint256)",
  "Claimed(address,uint256)",
  "Redeemed(address,uint256)",
  "Exchanged(address,uint256)",
  "Converted(address,uint256)",
] as const;

interface EventSelectorEntry {
  signature: string;
  topic: `0x${string}`;
}

export const migrationEventSelectors: EventSelectorEntry[] = MIGRATION_EVENT_SIGNATURES.map((signature) => ({
  signature,
  topic: toEventSelector(signature),
}));

/**
 * Heuristically scans deployed runtime bytecode for the 32-byte topic hashes
 * of known migration-style events. Solidity embeds an event's topic0 as a
 * PUSH32 immediate right before the LOGn that emits it, so a substring match
 * against the hex bytecode reliably (if not with 100% precision) detects
 * whether the contract can emit that event.
 */
export function scanBytecodeForMigrationEvents(bytecode: `0x${string}` | string): string[] {
  const code = bytecode.toLowerCase();
  const matched: string[] = [];

  for (const { signature, topic } of migrationEventSelectors) {
    const needle = topic.slice(2).toLowerCase();
    if (code.includes(needle)) {
      matched.push(signature);
    }
  }

  return matched;
}
