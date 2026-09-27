export type FunctionStrength = "strong" | "weak";

const STRONG_KEYWORDS = /migrat|convert|swap|exchange/i;
// Ambiguous: also found on plain tokens (USDT's redeem), vaults and staking.
const WEAK_KEYWORDS = /claim|redeem|deposit/i;
// Proxy admin entry points, not token migration.
const EXCLUDED = /^upgradeTo(AndCall)?$/;

// "<old>To<New>" converters such as mkrToSky, daiToUsds, lendToAave — but not
// generic verbs that happen to take a recipient (transferTo, mintTo, ...).
const X_TO_Y = /^([a-z][a-z0-9]*)To[A-Z][A-Za-z0-9]*$/;
const NON_CONVERSION_VERBS = new Set([
  "set", "get", "is", "has", "can", "transfer", "send", "mint", "safe", "approve", "withdraw",
  "deposit", "add", "remove", "update", "emergency", "upgrade", "bridge", "pay", "move", "return",
]);

/**
 * How strongly a function signature (e.g. "migrateFromLEND(uint256)")
 * indicates token-migration logic, or null if it doesn't.
 */
export function classifyFunctionSignature(signature: string): FunctionStrength | null {
  const name = signature.split("(")[0] ?? "";
  if (!name || EXCLUDED.test(name)) return null;

  if (STRONG_KEYWORDS.test(name)) return "strong";

  const xToY = X_TO_Y.exec(name);
  if (xToY && !NON_CONVERSION_VERBS.has(xToY[1]!)) return "strong";

  if (WEAK_KEYWORDS.test(name)) return "weak";
  return null;
}
