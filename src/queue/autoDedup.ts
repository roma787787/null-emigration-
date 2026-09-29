import type { Redis } from "ioredis";
import { createRedisConnection } from "./redisClient.js";
import { env } from "../config/env.js";

let redis: Redis | undefined;

/**
 * True the first time any of `keys` is seen within AUTO_DEDUP_HOURS; false
 * if one of them was already seen (a repeat of the same token pair, or a
 * clone of already-alerted code). Marks all of them either way.
 */
export async function firstSighting(keys: string[]): Promise<boolean> {
  const hours = env.AUTO_DEDUP_HOURS;
  if (!(hours > 0)) return true;
  redis ??= createRedisConnection();
  const results = await Promise.all(keys.map((k) => redis!.set(`auto:seen:${k}`, "1", "EX", Math.round(hours * 3600), "NX")));
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
