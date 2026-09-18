import { toFunctionSelector } from "viem";

/**
 * Common signatures used by ERC-20 -> ERC-20 migration/swap/claim contracts.
 * This list is intentionally broad (multiple likely argument shapes per verb)
 * since we have no ABI/source for the newly deployed contract — only its
 * exact 4-byte selectors can be checked against the runtime bytecode.
 */
const MIGRATION_SIGNATURES = [
  "migrate()",
  "migrate(uint256)",
  "migrate(address)",
  "migrate(uint256,address)",
  "migrateTokens(uint256)",
  "migrateAll()",
  "swap()",
  "swap(uint256)",
  "swapTokens(uint256)",
  "swapExactTokensForTokens(uint256)",
  "claim()",
  "claim(uint256)",
  "claimTokens()",
  "claimTokens(uint256)",
  "exchange()",
  "exchange(uint256)",
  "exchangeTokens(uint256)",
  "deposit()",
  "deposit(uint256)",
  "depositTokens(uint256)",
  "convert()",
  "convert(uint256)",
  "convertTokens(uint256)",
  "redeem()",
  "redeem(uint256)",
] as const;

interface SelectorEntry {
  signature: string;
  selector: `0x${string}`;
}

export const migrationFunctionSelectors: SelectorEntry[] = MIGRATION_SIGNATURES.map((signature) => ({
  signature,
  selector: toFunctionSelector(signature),
}));

/**
 * Heuristically scans deployed runtime bytecode for PUSH4 selectors matching
 * known migration-style function signatures. Solidity's function dispatcher
 * embeds each public/external function's 4-byte selector directly as a
 * PUSH4 immediate, so a substring match against the hex bytecode is a
 * reliable (if not 100% precise) way to detect their presence without an
 * ABI or verified source.
 */
export function scanBytecodeForMigrationSelectors(bytecode: `0x${string}` | string): string[] {
  const code = bytecode.toLowerCase();
  const matched: string[] = [];

  for (const { signature, selector } of migrationFunctionSelectors) {
    const needle = selector.slice(2).toLowerCase();
    if (code.includes(needle)) {
      matched.push(signature);
    }
  }

  return matched;
}
