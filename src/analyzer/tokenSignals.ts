import { decodeFunctionResult, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import type { NetworkKey } from "../types/index.js";
import { isBaseAsset } from "../config/marketAssets.js";

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
// Only names that mean "the token being retired" — not tokenIn()/fromToken(),
// which every swap bot and aggregator has.
const OLD_TOKEN_GETTERS = ["oldToken()", "legacyToken()", "previousToken()", "v1Token()", "tokenV1()", "oldTokenAddress()"];
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

// ERC-4626 vaults: a share token over an underlying asset(), with the
// standard convertToShares/convertToAssets — deposits, not migrations.
const VAULT_SELECTORS = ["asset()", "totalAssets()"].map((sig) => toFunctionSelector(sig));
const VAULT_CONVERT = ["convertToShares(uint256)", "convertToAssets(uint256)"].map((sig) => toFunctionSelector(sig));

export function isErc4626Vault(selectors: Hex[]): boolean {
  return VAULT_SELECTORS.every((s) => selectors.includes(s)) && VAULT_CONVERT.some((s) => selectors.includes(s));
}

// Callbacks a contract implements to be called back mid-swap or mid-flash-loan:
// trading bots, routers, liquidators, leverage helpers — never a token migrator.
const BOT_CALLBACKS = [
  "uniswapV3SwapCallback(int256,int256,bytes)",
  "pancakeV3SwapCallback(int256,int256,bytes)",
  "algebraSwapCallback(int256,int256,bytes)",
  "uniswapV3FlashCallback(uint256,uint256,bytes)",
  "uniswapV2Call(address,uint256,uint256,bytes)",
  "pancakeCall(address,uint256,uint256,bytes)",
  "unlockCallback(bytes)",
  "executeOperation(address,uint256,uint256,address,bytes)",
  "executeOperation(address[],uint256[],uint256[],address,bytes)",
  "receiveFlashLoan(address[],uint256[],uint256[],bytes)",
  "onFlashLoan(address,address,uint256,uint256,bytes)",
].map((sig) => toFunctionSelector(sig));

export function hasBotCallbacks(selectors: Hex[]): boolean {
  return BOT_CALLBACKS.some((s) => selectors.includes(s));
}

// What a deposit / lending wrapper returns as the asset it wraps: Aave's
// aTokens, Compound's cTokens, ERC-4626 shares.
const UNDERLYING_GETTERS = ["UNDERLYING_ASSET_ADDRESS()", "underlying()", "asset()"].map((sig) => toFunctionSelector(sig));
const ADDRESS_ABI = [{ type: "function", name: "f", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const;

/**
 * Whether `token` wraps a base asset (aWETH, cUSDC, a USDC vault share):
 * as much never a migration's old token as WETH or USDC themselves.
 */
export async function wrapsBaseAsset(client: PublicClient, network: NetworkKey, token: Address): Promise<boolean> {
  for (const selector of UNDERLYING_GETTERS) {
    try {
      const { data } = await client.call({ to: token, data: selector });
      if (!data || data.length !== 66) continue;
      const underlying = decodeFunctionResult({ abi: ADDRESS_ABI, functionName: "f", data });
      if (isBaseAsset(network, underlying)) return true;
    } catch {
      // not this kind of wrapper
    }
  }
  return false;
}

/**
 * A function that performs a migration — `migrate`, `migrateFromLEND`,
 * `convertTokens` — as opposed to settings, flags and views that merely
 * mention it (`setMigratedPool`, `migratedPools`, `migrationEnded`,
 * `isConverted`) or ERC-4626's `convertToShares`/`convertToAssets`.
 */
export function isMigrationAction(name: string): boolean {
  if (!/^(migrate|convert)/i.test(name)) return false;
  if (/^(migrated|converted)/i.test(name)) return false;
  return !/^convertTo(Shares|Assets)$/i.test(name);
}

// Upgradeable-proxy entry points: a proxy that has them but no implementation
// yet is only half deployed; what it will become is decided by a later call.
const PROXY_SELECTORS = ["upgradeTo(address)", "upgradeToAndCall(address,bytes)", "implementation()"].map((sig) =>
  toFunctionSelector(sig),
);

export function looksLikeProxy(selectors: Hex[]): boolean {
  return PROXY_SELECTORS.some((s) => selectors.includes(s));
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
