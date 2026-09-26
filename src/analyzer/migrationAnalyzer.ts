import type { Address } from "viem";
import type { ConfidenceLevel, MigrationAnalysisResult, NetworkKey, TokenBSource } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { scanBytecodeForMigrationSelectors } from "./functionSelectors.js";
import { scanBytecodeForMigrationEvents } from "./eventSignatures.js";
import { probeForTokenB, probeAuxiliarySignals } from "./staticCallProbe.js";
import { findTokenAOrBInConstructorArgs } from "./constructorArgsDecoder.js";
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

/**
 * A supplementary 0-100 display score (the "(95%)" in the spec's alert card
 * example) — weighted by how much evidence fired, on top of the categorical
 * HIGH/MEDIUM/LOW label above which is what settings/filtering actually key
 * off. A static-call getter returning Token B is the strongest single
 * signal; a bare Token A self-reference in the constructor is the weakest.
 */
export function computeConfidenceScore(input: ScoreInput): number {
  let score = 0;

  if (input.tokenBSource === "static_call") score += 45;
  else if (input.tokenBSource === "constructor_args") score += 35;
  else if (input.tokenBSource === "token_a_match") score += 20;

  score += Math.min(input.functionCount, 2) * 15;
  score += Math.min(input.eventCount, 2) * 10;
  score += Math.min(input.auxiliaryCount, 2) * 5;

  return Math.min(100, score);
}

export async function analyzeMigrationContract(
  network: NetworkKey,
  contractAddress: Address,
  creationInput: `0x${string}` | string,
  tokenAAddress: Address,
): Promise<MigrationAnalysisResult> {
  const client = getPublicClient(network);

  const bytecode = await client.getCode({ address: contractAddress });
  const matchedFunctions = bytecode ? scanBytecodeForMigrationSelectors(bytecode) : [];
  const matchedEvents = bytecode ? scanBytecodeForMigrationEvents(bytecode) : [];

  const matchedAuxiliary = await probeAuxiliarySignals(client, contractAddress).catch((err) => {
    logger.warn({ err, network, contractAddress }, "Auxiliary signal probe failed");
    return [] as string[];
  });

  const staticProbe = await probeForTokenB(client, contractAddress).catch((err) => {
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
    if (constructorMatch) {
      tokenBAddress = constructorMatch.address;
      tokenBSource = constructorMatch.matchType === "token_a" ? "token_a_match" : "constructor_args";
    }
  }

  const confidence = computeConfidence(matchedFunctions.length > 0, tokenBAddress !== null);
  const confidenceScore = computeConfidenceScore({
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
