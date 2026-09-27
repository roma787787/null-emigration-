import type { TokenOwnerRecord, TokenRecord } from "../types/index.js";
import { discoverAllOwners, type DiscoveredOwner } from "./ownerDiscovery.js";
import { ownerRepository } from "../db/repositories/ownerRepository.js";
import { tokenRepository } from "../db/repositories/tokenRepository.js";
import { logger } from "../utils/logger.js";

// Etherscan's free tier allows 5 requests/s; one deployer lookup per token.
const PAUSE_BETWEEN_TOKENS_MS = 300;

/** Discovered wallets not linked to the token yet. */
export function newOwners(existing: TokenOwnerRecord[], discovered: DiscoveredOwner[]): DiscoveredOwner[] {
  const known = new Set(existing.map((o) => o.address.toLowerCase()));
  return discovered.filter((o) => !known.has(o.address.toLowerCase()));
}

export interface OwnersRefreshed {
  token: TokenRecord;
  added: DiscoveredOwner[];
}

/**
 * Re-runs owner discovery for every tracked token and links wallets that
 * weren't known yet (e.g. ownership moved to a new wallet or multisig).
 * Previously linked wallets are kept: an ex-owner or the original deployer
 * can still deploy the migrator.
 */
export async function refreshAllOwners(onAdded: (result: OwnersRefreshed) => Promise<void>): Promise<number> {
  const tokens = await tokenRepository.listAll();
  let totalAdded = 0;

  for (const token of tokens) {
    try {
      const discovered = await discoverAllOwners(token.network, token.address);
      const added = newOwners(await ownerRepository.listForToken(token.id), discovered);
      for (const owner of added) await ownerRepository.upsert(token.id, owner.address, owner.source);
      if (added.length > 0) {
        totalAdded += added.length;
        logger.info({ network: token.network, token: token.address, added }, "Found new owners for tracked token");
        await onAdded({ token, added });
      }
    } catch (err) {
      logger.warn({ err, network: token.network, token: token.address }, "Owner refresh failed for token");
    }
    await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_TOKENS_MS));
  }

  logger.info({ tokens: tokens.length, added: totalAdded }, "Owner refresh finished");
  return totalAdded;
}
