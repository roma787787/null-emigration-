import type { Address } from "viem";
import type { MigrationAnalysisResult, NetworkKey } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { scanBytecodeForMigrationSelectors } from "./functionSelectors.js";
import { probeForTokenB } from "./staticCallProbe.js";
import { findTokenBInConstructorArgs } from "./constructorArgsDecoder.js";
import { logger } from "../utils/logger.js";

/**
 * Implements the classification rules from spec section 4.3.4:
 *  - HIGH: Token B address found AND migration-style functions present.
 *  - MEDIUM: migration-style functions present, or a plausible Token B was
 *    found, but not both.
 *  - LOW: neither signal present.
 */
export async function analyzeMigrationContract(
  network: NetworkKey,
  contractAddress: Address,
  creationInput: `0x${string}` | string,
): Promise<MigrationAnalysisResult> {
  const client = getPublicClient(network);

  const bytecode = await client.getCode({ address: contractAddress });
  const matchedFunctions = bytecode ? scanBytecodeForMigrationSelectors(bytecode) : [];

  const staticProbe = await probeForTokenB(client, contractAddress).catch((err) => {
    logger.warn({ err, network, contractAddress }, "Static call probe failed");
    return { tokenBAddress: null, matchedGetter: null };
  });

  let tokenBAddress = staticProbe.tokenBAddress;
  let tokenBSource: MigrationAnalysisResult["tokenBSource"] = tokenBAddress ? "static_call" : null;

  if (!tokenBAddress) {
    tokenBAddress = await findTokenBInConstructorArgs(client, creationInput).catch((err) => {
      logger.warn({ err, network, contractAddress }, "Constructor args decoding failed");
      return null;
    });
    if (tokenBAddress) tokenBSource = "constructor_args";
  }

  const hasFunctions = matchedFunctions.length > 0;
  const hasTokenB = tokenBAddress !== null;

  const confidence: MigrationAnalysisResult["confidence"] =
    hasFunctions && hasTokenB ? "HIGH" : hasFunctions || hasTokenB ? "MEDIUM" : "LOW";

  return {
    confidence,
    tokenBAddress,
    tokenBSource,
    matchedFunctions,
  };
}
