import type { Address } from "viem";
import type { NetworkKey } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { readTokenSymbol, readTokenText } from "../chain/tokenMetadata.js";
import { isErc20 } from "../analyzer/genericTokenProbe.js";
import { logger } from "../utils/logger.js";

/**
 * New tokens launched by registered RWA custodians — a Robinhood stock token
 * listing, a new Dinari dShare. Not migrations: the custodian watch already
 * sees every one of these deployments, and a chat that wants them gets a
 * card per token, or one digest when the issuer launches a batch.
 */

export interface RwaListing {
  network: NetworkKey;
  /** The custodian's label, e.g. "Robinhood Stock Tokens". */
  issuer: string;
  address: Address;
  symbol: string;
  name: string | null;
}

export interface ListingBatch {
  network: NetworkKey;
  issuer: string;
  listings: RwaListing[];
}

/** The token a custodian just deployed, if it is one (a factory, a vault or a migrator is not a listing). */
export async function readListing(network: NetworkKey, address: Address, issuer: string): Promise<RwaListing | null> {
  const client = getPublicClient(network);
  if (!(await isErc20(client, address))) return null;
  const symbol = await readTokenSymbol(client, address);
  if (!symbol) return null;
  const name = await readTokenText(client, address, "name");
  return { network, issuer, address, symbol, name: name && name !== symbol ? name : null };
}

export interface BatcherOptions {
  /** How long a first listing waits for others from the same issuer before going out. */
  windowMs: number;
  /** The same wait while the issuer is launching a batch (after the hourly cap was hit). */
  busyWindowMs: number;
  /** A flush of at most this many listings goes out as separate cards… */
  singleMax: number;
  /** …while fewer than this many separate cards went out for the issuer in the past hour. */
  hourlyCap: number;
}

export function batcherOptionsFromEnv(): BatcherOptions {
  const num = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    windowMs: num("RWA_LISTING_WINDOW_MS", 20_000),
    busyWindowMs: num("RWA_LISTING_BUSY_WINDOW_MS", 15 * 60_000),
    singleMax: num("RWA_LISTING_SINGLE_MAX", 3),
    hourlyCap: num("RWA_LISTING_HOURLY_CAP", 10),
  };
}

const HOUR_MS = 60 * 60_000;

interface Bucket {
  items: RwaListing[];
  timer: NodeJS.Timeout | null;
  /** When separate cards went out, for the hourly cap. */
  singlesSent: number[];
  /** Issuer in the middle of a launch: batches wait longer and go out as digests. */
  busyUntil: number;
}

/**
 * Groups listings per issuer and network. A lone new token is a card of its
 * own; a launch of hundreds (Robinhood has shipped 500 in a day) becomes a
 * few digests instead of hundreds of messages: at most `hourlyCap` separate
 * cards an hour, then one digest per `busyWindowMs` while the launch lasts.
 */
export class ListingBatcher {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly send: (batch: ListingBatch) => Promise<void>,
    private readonly options: BatcherOptions = batcherOptionsFromEnv(),
    private readonly now: () => number = Date.now,
  ) {}

  add(listing: RwaListing): void {
    const key = `${listing.network}\u0000${listing.issuer}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { items: [], timer: null, singlesSent: [], busyUntil: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.items.some((l) => l.address.toLowerCase() === listing.address.toLowerCase())) return;
    bucket.items.push(listing);
    if (!bucket.timer) {
      const wait = bucket.busyUntil > this.now() ? this.options.busyWindowMs : this.options.windowMs;
      bucket.timer = setTimeout(() => void this.flush(key), wait);
    }
  }

  /** Sends everything still waiting (on shutdown). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.buckets.keys()].map((key) => this.flush(key)));
  }

  private async flush(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = null;
    const items = bucket.items.splice(0);
    if (items.length === 0) return;

    const now = this.now();
    bucket.singlesSent = bucket.singlesSent.filter((at) => now - at < HOUR_MS);
    const { network, issuer } = items[0]!;
    const asSingles =
      bucket.busyUntil <= now &&
      items.length <= this.options.singleMax &&
      bucket.singlesSent.length + items.length <= this.options.hourlyCap;
    try {
      if (asSingles) {
        for (const listing of items) {
          await this.send({ network, issuer, listings: [listing] });
          bucket.singlesSent.push(now);
        }
      } else {
        await this.send({ network, issuer, listings: items });
        bucket.busyUntil = now + HOUR_MS;
      }
    } catch (err) {
      logger.error({ err, network, issuer, count: items.length }, "Failed to deliver RWA listing alert");
    }
  }
}
