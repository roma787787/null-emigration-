import { getAddress, isAddressEqual, keccak256, type Address } from "viem";
import type { MigrationAnalysisResult, NetworkKey, TokenBSource } from "../types/index.js";
import { isBaseAsset } from "../config/marketAssets.js";
import { readTokenSymbol } from "../chain/tokenMetadata.js";
import { computeConfidence, computeConfidenceScore, inspectContract } from "./migrationAnalyzer.js";
import { collectTokenGetters, isErc20, targetRank, type TokenReference } from "./genericTokenProbe.js";
import { extractAddressCandidatesFromConstructorArgs } from "./constructorArgsDecoder.js";
import { probeAuxiliarySignals } from "./staticCallProbe.js";
import { extractAddressConstants } from "./bytecodeSelectors.js";
import {
  findRwaSignals,
  findSymbolOnlyTokenB,
  hasBotCallbacks,
  hasOldTokenGetter,
  isErc4626Vault,
  isLaunchpadToken,
  isLiquidityPool,
  isMigrationAction,
  looksLikeProxy,
  wrapsBaseAsset,
} from "./tokenSignals.js";
import { logger } from "../utils/logger.js";

/**
 * Auto-discovery (spec task 2): decides, for ANY freshly created contract,
 * whether it is a migration and which tokens it moves between — without a
 * tracked Token A to go on. Everything is tied by contract address; token
 * symbols are only ever displayed, never matched (spec task 1).
 */

export interface AutoAnalysisResult extends MigrationAnalysisResult {
  tokenAAddress: Address;
  tokenASymbol: string | null;
  /** Getter or "constructor" that exposed Token A. */
  tokenAGetter: string;
  /** Set when names couldn't tell old from new: the other token, which the liquidity check may swap in as Token A. */
  alternateTokenA: Address | null;
  /** keccak256 of the runtime code (proxy + implementation): identical clones share it. */
  codeHash: `0x${string}`;
  /**
   * Admitted only on a plain `swap(uint256)`-style function: a real
   * old→new swap migrator — or a bot. The worker tells them apart by Token
   * B's market: a new token has none yet, a bot trades two liquid tokens.
   */
  swapOnly: boolean;
}

export type AutoAnalysisOutcome =
  | { kind: "candidate"; result: AutoAnalysisResult }
  /** `recheck`: may still become a migration once configured (tokens set later, proxy implementation set later). */
  | { kind: "skipped"; reason: string; recheck?: boolean };

// On a contract that is itself an ERC-20, only these names mean migration —
// swap/exchange there are fee-swap plumbing (swapTokensForEth, swapBack).
const TOKEN_MIGRATION_NAME = /migrat|convert/i;
const SWAP_NAME = /swap|exchange/i;
const AMOUNT_ONLY_SWAP = /^(swap|exchange)(tokens?)?\(uint256\)$/i;
const OLD_NAME = /old|legacy|prev|from|v1|source/i;
const FROM_X = /from([A-Za-z0-9]+)/i;
const X_TO_Y = /^([a-z][a-z0-9]*)To([A-Z][A-Za-z0-9]*)$/;

/** Where a token reference came from, as a Token B source. */
export function sourceOf(label: string): TokenBSource {
  return label === "constructor" ? "constructor_args" : label === "bytecode" ? "bytecode" : "static_call";
}

const nameOf = (signature: string) => signature.split("(")[0] ?? "";
const labelIs = (ref: TokenReference, name: string) => ref.labels.some((l) => l.toLowerCase() === name.toLowerCase());

/**
 * Which referenced token is the old one (A) and which the new one (B), from
 * names alone: getter names (oldToken / newToken), then function names
 * (migrateFromLEND → the LEND() getter is A; mkrToSky → mkr() is A, sky() is B).
 */
export function orderTokens(
  refs: TokenReference[],
  functionNames: string[],
): { tokenA: TokenReference | null; tokenB: TokenReference | null; decided: boolean } {
  if (refs.length === 0) return { tokenA: null, tokenB: null, decided: false };

  let tokenA = refs.find((r) => r.labels.some((l) => OLD_NAME.test(l)) && targetRank(r.labels) !== 0) ?? null;
  let tokenB = refs.find((r) => targetRank(r.labels) === 0 && r !== tokenA) ?? null;

  for (const fn of functionNames) {
    const xToY = X_TO_Y.exec(fn);
    if (xToY) {
      tokenA ??= refs.find((r) => labelIs(r, xToY[1]!)) ?? null;
      tokenB ??= refs.find((r) => labelIs(r, xToY[2]!) && r !== tokenA) ?? null;
    }
    const fromX = FROM_X.exec(fn);
    if (fromX) tokenA ??= refs.find((r) => labelIs(r, fromX[1]!) && r !== tokenB) ?? null;
  }

  const decided = tokenA !== null;
  tokenA ??= refs.find((r) => r !== tokenB) ?? null;
  tokenB ??= refs.find((r) => r !== tokenA) ?? null;
  return { tokenA, tokenB, decided };
}

export async function analyzeAutoCandidate(
  network: NetworkKey,
  contractAddress: Address,
  creationInput: `0x${string}` | string,
): Promise<AutoAnalysisOutcome> {
  const inspection = await inspectContract(network, contractAddress);
  const { client, proxyCode, selectors, signatures, isToken, strong, matchedEvents, implementation } = inspection;
  if (!proxyCode || proxyCode === "0x") return { kind: "skipped", reason: "no code" };
  if (isLiquidityPool(selectors)) return { kind: "skipped", reason: "liquidity pool" };
  if (isErc4626Vault(selectors)) return { kind: "skipped", reason: "ERC-4626 vault" };
  if (hasBotCallbacks(selectors)) return { kind: "skipped", reason: "swap / flash-loan callbacks (bot)" };
  if (isLaunchpadToken(selectors)) return { kind: "skipped", reason: "launchpad token (pool graduation settings)" };
  if (!implementation && looksLikeProxy(selectors) && strong.length === 0) {
    return { kind: "skipped", reason: "proxy without implementation", recheck: true };
  }

  // Spec workflow step 2 (migrate / swap / convert / oldToken()), tightened
  // for a firehose of every new contract: migrate/convert names or an
  // oldToken()-style getter carry a contract through; an "xToY" converter
  // only once x and y turn out to be its own token getters (below); and
  // swap/exchange never alone — bots, zaps, presales and fee plumbing are
  // full of them — only alongside one of the above.
  const nameSignals = strong.filter((s) => isMigrationAction(s));
  const converterNames = isToken ? [] : strong.filter((s) => X_TO_Y.test(nameOf(s)) && !SWAP_NAME.test(nameOf(s)));
  const swapNames = isToken ? [] : strong.filter((s) => SWAP_NAME.test(nameOf(s)) && !TOKEN_MIGRATION_NAME.test(nameOf(s)));
  const oldGetter = hasOldTokenGetter(selectors);
  // `swap(uint256)` / `exchange(uint256)`: hand in N old tokens, get the new
  // ones — the shape of a "TokenSwap" migrator (bots and zaps take routes,
  // paths, minimum outputs, not a bare amount).
  const amountOnlySwaps = swapNames.filter((s) => AMOUNT_ONLY_SWAP.test(s));
  const swapOnly = nameSignals.length === 0 && !oldGetter && converterNames.length === 0;
  if (swapOnly && amountOnlySwaps.length === 0) {
    return { kind: "skipped", reason: swapNames.length > 0 ? "swap functions only" : "no migration signature" };
  }

  // Every ERC-20 the contract points at — from its getters, then its
  // constructor args — minus wrapped-native and stables, which are never the
  // token being migrated away from.
  const fromGetters = await collectTokenGetters(client, contractAddress, selectors, signatures);
  const fromConstructor: TokenReference[] = [];
  for (const address of extractAddressCandidatesFromConstructorArgs(creationInput)) {
    if (isAddressEqual(address, contractAddress) || fromGetters.some((r) => isAddressEqual(r.address, address))) continue;
    if (await isErc20(client, address)) fromConstructor.push({ address, labels: ["constructor"] });
  }
  // Addresses compiled into the code (constants, immutables) of the contract
  // or its implementation — tokens a migrator uses but exposes no getter for.
  const fromBytecode: TokenReference[] = [];
  const known = [contractAddress, ...fromGetters.map((r) => r.address), ...fromConstructor.map((r) => r.address)];
  for (const address of extractAddressConstants(inspection.bytecode)) {
    if (known.some((k) => isAddressEqual(k, address as Address))) continue;
    if (await isErc20(client, getAddress(address))) fromBytecode.push({ address: getAddress(address), labels: ["bytecode"] });
  }
  // …and wrappers of those (Aave aWETH, Compound cUSDC, vault shares).
  const refs: TokenReference[] = [];
  for (const r of [...fromGetters, ...fromConstructor, ...fromBytecode]) {
    if (isBaseAsset(network, r.address) || (await wrapsBaseAsset(client, network, r.address))) continue;
    refs.push(r);
  }
  // A migrator whose tokens are set by a later call (setTokens / initialize).
  if (refs.length === 0) return { kind: "skipped", reason: "no token referenced", recheck: true };

  // An "xToY" converter counts only when x and y are getters of tokens it holds (mkrToSky → mkr(), sky()).
  const verifiedConverters = converterNames.filter((s) => {
    const m = X_TO_Y.exec(nameOf(s));
    return !!m && refs.some((r) => labelIs(r, m[1]!)) && refs.some((r) => labelIs(r, m[2]!));
  });
  if (nameSignals.length === 0 && !oldGetter && verifiedConverters.length === 0 && amountOnlySwaps.length === 0) {
    return { kind: "skipped", reason: "converter names don't match its tokens" };
  }
  const migrationFunctions = [...nameSignals, ...verifiedConverters, ...swapNames];
  const functionNames = migrationFunctions.map(nameOf);
  let tokenA: TokenReference | null;
  let tokenB: TokenReference | null;
  let decided: boolean;
  let tokenBSource: TokenBSource | null = null;
  if (isToken) {
    // A token with migrate()/convert() and a pointer to another token: it is
    // the new token, minting itself in exchange for the old one.
    ({ tokenA, decided } = orderTokens(refs, functionNames));
    tokenB = null;
    tokenBSource = "contract_itself";
    decided = true;
  } else {
    ({ tokenA, tokenB, decided } = orderTokens(refs, functionNames));
    if (tokenB) tokenBSource = sourceOf(tokenB.labels[0]!);
  }
  if (!tokenA) return { kind: "skipped", reason: "no token referenced" };

  const tokenBAddress = isToken ? contractAddress : (tokenB?.address ?? null);
  const symbolOnly = tokenBAddress
    ? null
    : await findSymbolOnlyTokenB(client, contractAddress, signatures).catch(() => null);
  // A migration moves an old token into a new one: with no Token B at all
  // (neither an address nor a ticker) it isn't alertable yet — look again
  // later, in case the target is set after deploy.
  if (!tokenBAddress && !symbolOnly) return { kind: "skipped", reason: "no Token B", recheck: true };

  const matchedAuxiliary = await probeAuxiliarySignals(client, contractAddress).catch((err) => {
    logger.warn({ err, network, contractAddress }, "Auxiliary signal probe failed");
    return [] as string[];
  });

  const matchedFunctions = [...migrationFunctions, ...(oldGetter && migrationFunctions.length === 0 ? ["oldToken()"] : [])];
  const confidence = symbolOnly ? "LOW" : computeConfidence(true, tokenBAddress !== null);
  const confidenceScore = computeConfidenceScore(confidence, {
    tokenBSource,
    strongFunctionCount: migrationFunctions.length,
    weakFunctionCount: 0,
    eventCount: matchedEvents.length,
    auxiliaryCount: matchedAuxiliary.length,
  });

  return {
    kind: "candidate",
    result: {
      tokenAAddress: tokenA.address,
      tokenASymbol: await readTokenSymbol(client, tokenA.address),
      tokenAGetter: tokenA.labels[0]!,
      alternateTokenA: !decided && tokenB ? tokenB.address : null,
      codeHash: keccak256(inspection.bytecode as `0x${string}`),
      swapOnly: nameSignals.length === 0 && !oldGetter && verifiedConverters.length === 0,
      confidence,
      confidenceScore,
      tokenBAddress,
      tokenBSource: tokenBAddress ? tokenBSource : null,
      matchedGetter: tokenBSource === "static_call" ? (tokenB?.labels[0] ?? null) : null,
      matchedFunctions,
      matchedEvents,
      matchedAuxiliary,
      tokenBSymbolUnverified: symbolOnly?.symbol ?? null,
      rwaSignals: findRwaSignals(selectors),
    },
  };
}
