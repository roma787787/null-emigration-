import type { Address } from "viem";
import type { ConfidenceLevel, MigrationAnalysisResult, NetworkKey, TokenBSource } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { scanBytecodeForMigrationSelectors } from "./functionSelectors.js";
import { scanBytecodeForMigrationEvents } from "./eventSignatures.js";
import { probeForTokenB, probeAuxiliarySignals } from "./staticCallProbe.js";
import { findTokenAOrBInConstructorArgs } from "./constructorArgsDecoder.js";
import { findProxyImplementation } from "./proxyResolver.js";
import { logger } from "../utils/logger.js";

/**
 * Implements the classification rules from spec section 4.3.5:
 *  - HIGH: a Token B address was found (or the constructor referenced Token
 *    A itself) AND migration-style functions are present.
 *  - MEDIUM: migration-style functions are present, or a plausible Token B /
 *    Token A reference was found, but not both.
 *  - LOW: neither signal present.
 */
export function computeConfidence(hasFunctions: boolean, hasTokenSignal: boolean): ConfidenceLevel {
  if (hasFunctions && hasTokenSignal) return "HIGH";
  if (hasFunctions || hasTokenSignal) return "MEDIUM";
  return "LOW";
}

interface ScoreInput {
  tokenBSource: TokenBSource | null;
  functionCount: number;
  eventCount: number;
  auxiliaryCount: number;
}

const SCORE_BANDS: Record<ConfidenceLevel, [number, number]> = {
  LOW: [0, 39],
  MEDIUM: [40, 69],
  HIGH: [70, 100],
};

/**
 * The 0-100 display score (the "(95%)" in the spec's alert card example).
 * It always lands inside its label's band — HIGH 70-100, MEDIUM 40-69,
 * LOW 0-39 — so the card never shows e.g. "HIGH (35%)"; the weighted
 * evidence only decides the position within that band. A static-call getter
 * returning Token B is the strongest single signal, a bare Token A
 * reference in the constructor the weakest.
 */
export function computeConfidenceScore(confidence: ConfidenceLevel, input: ScoreInput): number {
  let evidence = 0;

  if (input.tokenBSource === "static_call") evidence += 45;
  else if (input.tokenBSource === "constructor_args") evidence += 35;
  else if (input.tokenBSource === "token_a_match") evidence += 20;

  evidence += Math.min(input.functionCount, 2) * 15;
  evidence += Math.min(input.eventCount, 2) * 10;
  evidence += Math.min(input.auxiliaryCount, 2) * 5;

  const [min, max] = SCORE_BANDS[confidence];
  return min + Math.round((Math.min(100, evidence) / 100) * (max - min));
}

export async function analyzeMigrationContract(
  network: NetworkKey,
  contractAddress: Address,
  creationInput: `0x${string}` | string,
  tokenAAddress: Address,
): Promise<MigrationAnalysisResult> {
  const client = getPublicClient(network);

  const proxyCode = await client.getCode({ address: contractAddress });
  const implementation = proxyCode
    ? await findProxyImplementation(client, contractAddress, proxyCode).catch((err) => {
        logger.warn({ err, network, contractAddress }, "Proxy implementation lookup failed");
        return null;
      })
    : null;
  const implementationCode = implementation ? await client.getCode({ address: implementation }) : undefined;
  // Scan the proxy and its implementation together: for a proxied migrator,
  // migrate()/Migrated live only in the implementation's bytecode.
  const bytecode = (proxyCode ?? "") + (implementationCode?.slice(2) ?? "");
  const matchedFunctions = bytecode ? scanBytecodeForMigrationSelectors(bytecode) : [];
  const matchedEvents = bytecode ? scanBytecodeForMigrationEvents(bytecode) : [];

  const matchedAuxiliary = await probeAuxiliarySignals(client, contractAddress).catch((err) => {
    logger.warn({ err, network, contractAddress }, "Auxiliary signal probe failed");
    return [] as string[];
  });

  const staticProbe = await probeForTokenB(client, contractAddress, tokenAAddress).catch((err) => {
    logger.warn({ err, network, contractAddress }, "Static call probe failed");
    return { tokenBAddress: null, matchedGetter: null };
  });

  let tokenBAddress = staticProbe.tokenBAddress;
  let tokenBSource: TokenBSource | null = tokenBAddress ? "static_call" : null;
  const matchedGetter = staticProbe.matchedGetter;

  if (!tokenBAddress) {
    const constructorMatch = await findTokenAOrBInConstructorArgs(client, creationInput, tokenAAddress).catch(
      (err) => {
        logger.warn({ err, network, contractAddress }, "Constructor args decoding failed");
        return null;
      },
    );
    if (constructorMatch?.tokenB) {
      tokenBAddress = constructorMatch.tokenB;
      tokenBSource = "constructor_args";
    } else if (constructorMatch?.referencesTokenA) {
      // A Token A reference counts as a token signal, but Token B stays unset
      // so the card never presents the old token as the migration target.
      tokenBSource = "token_a_match";
    }
  }

  const hasTokenSignal = tokenBAddress !== null || tokenBSource === "token_a_match";
  const confidence = computeConfidence(matchedFunctions.length > 0, hasTokenSignal);
  const confidenceScore = computeConfidenceScore(confidence, {
    tokenBSource,
    functionCount: matchedFunctions.length,
    eventCount: matchedEvents.length,
    auxiliaryCount: matchedAuxiliary.length,
  });

  return {
    confidence,
    confidenceScore,
    tokenBAddress,
    tokenBSource,
    matchedGetter,
    matchedFunctions,
    matchedEvents,
    matchedAuxiliary,
  };
}
