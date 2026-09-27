import { isAddressEqual, type Address } from "viem";
import type { MigrationAnalysisResult, NetworkKey, TokenBSource } from "../types/index.js";
import { isBaseAsset } from "../config/marketAssets.js";
import { readTokenSymbol } from "../chain/tokenMetadata.js";
import { computeConfidence, computeConfidenceScore, inspectContract } from "./migrationAnalyzer.js";
import { collectTokenGetters, isErc20, targetRank, type TokenReference } from "./genericTokenProbe.js";
import { extractAddressCandidatesFromConstructorArgs } from "./constructorArgsDecoder.js";
import { probeAuxiliarySignals } from "./staticCallProbe.js";
import { findRwaSignals, findSymbolOnlyTokenB, hasOldTokenGetter, isLiquidityPool } from "./tokenSignals.js";
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
}

export type AutoAnalysisOutcome = { kind: "candidate"; result: AutoAnalysisResult } | { kind: "skipped"; reason: string };

// On a contract that is itself an ERC-20, only these names mean migration —
// swap/exchange there are fee-swap plumbing (swapTokensForEth, swapBack).
const TOKEN_MIGRATION_NAME = /migrat|convert/i;
const OLD_NAME = /old|legacy|prev|from|v1|source/i;
const FROM_X = /from([A-Za-z0-9]+)/i;
const X_TO_Y = /^([a-z][a-z0-9]*)To([A-Z][A-Za-z0-9]*)$/;

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
  const { client, proxyCode, selectors, signatures, isToken, strong, matchedEvents } = inspection;
  if (!proxyCode || proxyCode === "0x") return { kind: "skipped", reason: "no code" };
  if (isLiquidityPool(selectors)) return { kind: "skipped", reason: "liquidity pool" };

  const migrationFunctions = isToken ? strong.filter((s) => TOKEN_MIGRATION_NAME.test(nameOf(s))) : strong;
  const oldGetter = hasOldTokenGetter(selectors);
  // Spec workflow step 2: no migrate / swap / convert / oldToken() — ignore.
  if (migrationFunctions.length === 0 && !oldGetter) return { kind: "skipped", reason: "no migration signature" };

  // Every ERC-20 the contract points at — from its getters, then its
  // constructor args — minus wrapped-native and stables, which are never the
  // token being migrated away from.
  const fromGetters = await collectTokenGetters(client, contractAddress, selectors, signatures);
  const fromConstructor: TokenReference[] = [];
  for (const address of extractAddressCandidatesFromConstructorArgs(creationInput)) {
    if (isAddressEqual(address, contractAddress) || fromGetters.some((r) => isAddressEqual(r.address, address))) continue;
    if (await isErc20(client, address)) fromConstructor.push({ address, labels: ["constructor"] });
  }
  const refs = [...fromGetters, ...fromConstructor].filter((r) => !isBaseAsset(network, r.address));
  if (refs.length === 0) return { kind: "skipped", reason: "no token referenced" };

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
    if (tokenB) tokenBSource = tokenB.labels[0] === "constructor" ? "constructor_args" : "static_call";
  }
  if (!tokenA) return { kind: "skipped", reason: "no token referenced" };

  const tokenBAddress = isToken ? contractAddress : (tokenB?.address ?? null);
  const symbolOnly = tokenBAddress
    ? null
    : await findSymbolOnlyTokenB(client, contractAddress, signatures).catch(() => null);

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
