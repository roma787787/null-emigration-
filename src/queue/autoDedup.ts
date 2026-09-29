import type { Redis } from "ioredis";
import { createRedisConnection } from "./redisClient.js";
import { env } from "../config/env.js";

let redis: Redis | undefined;

const seenKey = (k: string) => `auto:seen:${k}`;

/**
 * Whether an alert already went out, within AUTO_DEDUP_HOURS, for one of
 * `keys` (the same token pair, or clones of already-alerted code). Only
 * alerts count: a clone dropped for having no market must not block a
 * later one whose token does trade.
 */
export async function alreadyAlerted(keys: string[]): Promise<boolean> {
  if (!(env.AUTO_DEDUP_HOURS > 0)) return false;
  redis ??= createRedisConnection();
  return (await redis.exists(...keys.map(seenKey))) > 0;
}

/** Records an alert for `keys`; false when another job recorded one first (this one is then the duplicate). */
export async function markAlerted(keys: string[]): Promise<boolean> {
  const hours = env.AUTO_DEDUP_HOURS;
  if (!(hours > 0)) return true;
  redis ??= createRedisConnection();
  const results = await Promise.all(keys.map((k) => redis!.set(seenKey(k), "1", "EX", Math.round(hours * 3600), "NX")));
  return results.every((r) => r === "OK");
}

/** Dedup keys for an auto candidate: its token pair (order-independent) and its code. */
export function dedupKeys(network: string, tokenA: string, tokenB: string | null, codeHash: string): string[] {
  const pair = [tokenA.toLowerCase(), (tokenB ?? "-").toLowerCase()].sort().join(":");
  return [`${network}:pair:${pair}`, `${network}:code:${codeHash}`];
}

const LISTING_TTL_SEC = 30 * 24 * 3600;

/** True the first time a custodian's new token is seen (re-checks and restarts don't announce it again). */
export async function firstListing(network: string, address: string): Promise<boolean> {
  redis ??= createRedisConnection();
  return (await redis.set(`rwa:listing:${network}:${address.toLowerCase()}`, "1", "EX", LISTING_TTL_SEC, "NX")) === "OK";
}
