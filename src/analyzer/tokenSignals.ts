import { decodeFunctionResult, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";

// Tokenized stocks / RWA: registry identifiers and issuer links instead of a
// plain ERC-20 story (spec task 4).
const RWA_GETTERS = ["isin()", "cusip()", "underlyingAsset()", "issuer()"];
const RWA_SELECTORS = new Map(RWA_GETTERS.map((sig) => [toFunctionSelector(sig), sig]));

/** RWA getters present in the dispatcher (e.g. ["isin()", "issuer()"]). */
export function findRwaSignals(selectors: Hex[]): string[] {
  return selectors.flatMap((s) => {
    const sig = RWA_SELECTORS.get(s.toLowerCase() as Hex);
    return sig ? [sig] : [];
  });
}

// Getters that point at the token being migrated FROM (spec: oldToken()).
const OLD_TOKEN_GETTERS = [
  "oldToken()", "legacyToken()", "previousToken()", "fromToken()", "tokenFrom()", "v1Token()", "sourceToken()", "tokenIn()",
];
const OLD_TOKEN_SELECTORS = new Set(OLD_TOKEN_GETTERS.map((sig) => toFunctionSelector(sig)));

export function hasOldTokenGetter(selectors: Hex[]): boolean {
  return selectors.some((s) => OLD_TOKEN_SELECTORS.has(s.toLowerCase() as Hex));
}

// Uniswap V2/V3-style pools and pairs expose token0()/token1(): they reference
// two tokens and have swap(), but are never a migration.
const POOL_SELECTORS = ["token0()", "token1()"].map((sig) => toFunctionSelector(sig));

export function isLiquidityPool(selectors: Hex[]): boolean {
  return POOL_SELECTORS.every((s) => selectors.includes(s));
}

const STRING_ABI = [{ type: "function", name: "f", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }] as const;
const SYMBOL_GETTER = /symbol|ticker/i;
const PRINTABLE = /^[\x20-\x7E]{1,32}$/;

/**
 * Token B given only as a ticker (e.g. `newTokenSymbol()` → "ABC") with no
 * address anywhere. A ticker is not an identity — hundreds of tokens share
 * each one across networks — so this is reported as Unverified, never
 * matched to a token (spec task 1). The contract's own `symbol()` (when it
 * is itself a token) is not such a getter.
 */
export async function findSymbolOnlyTokenB(
  client: PublicClient,
  contractAddress: Address,
  signatures: Map<string, string>,
): Promise<{ symbol: string; getter: string } | null> {
  for (const [selector, signature] of signatures) {
    const name = signature.split("(")[0] ?? "";
    if (!signature.endsWith("()") || name === "symbol" || name === "name" || !SYMBOL_GETTER.test(name)) continue;
    try {
      const { data } = await client.call({ to: contractAddress, data: selector as Hex });
      if (!data || data === "0x") continue;
      const value = decodeFunctionResult({ abi: STRING_ABI, functionName: "f", data }).trim();
      if (PRINTABLE.test(value)) return { symbol: value, getter: name };
    } catch {
      // not a string getter
    }
  }
  return null;
}
