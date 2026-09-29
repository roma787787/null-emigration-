import { getContractAddress, type Address } from "viem";
import type { NetworkKey } from "../types/index.js";
import { getPublicClient } from "./provider.js";
import { custodianRepository } from "../db/repositories/custodianRepository.js";
import { networkCursorRepository } from "../db/repositories/networkCursorRepository.js";
import { findBlockCreates, findFactoryCreatedContracts } from "./traceCreateDetector.js";
import type { UntrackedCreationHandler } from "./blockListener.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Watches registered RWA custodians (Robinhood, Dinari, Backed…) on a
 * network without reading its blocks. Every deployment bumps the deployer's
 * nonce — a wallet's with each transaction it sends, a factory contract's
 * with each CREATE/CREATE2 it runs (EIP-161) — so polling the custodians'
 * transaction counts is enough to notice one. Only then are the blocks where
 * a count rose located (bisection over historical counts) and read.
 *
 * On a chain producing ~10 blocks a second (Robinhood Chain) that is a few
 * calls per poll instead of ten full blocks a second.
 */

export interface CustodianWatchStatus {
  network: NetworkKey;
  startedAt: Date;
  custodians: number;
  lastBlock: bigint | null;
  lastPollAt: Date | null;
  deployments: number;
  lastError: string | null;
  lastErrorAt: Date | null;
}

const statuses = new Map<NetworkKey, CustodianWatchStatus>();

export function custodianWatchStatuses(): CustodianWatchStatus[] {
  return [...statuses.values()];
}

// Most blocks one poll will read: a burst of deployments (hundreds of stock
// tokens launched at once) is worked through over the next polls.
const MAX_BLOCKS_PER_POLL = 50;
const CURSOR_SAVE_INTERVAL_MS = 30_000;
// A restart resumes from the saved block when it is at most this far behind
// (~14h on Robinhood Chain, weeks on Ethereum): finding the deployments in
// between costs a few reads each, not a read per block.
const MAX_CATCHUP_BLOCKS = 500_000n;
// After this many failed polls in a row the window is dropped and counts are
// re-read at the head: a node without the old state would otherwise block
// the watch forever.
const MAX_FAILED_POLLS = 5;

/**
 * Blocks in (from, to] where a monotonically rising counter went up, given
 * its values at both ends: the range is halved until each rise is pinned to
 * one block — ~log2(range) reads per block with a deployment.
 */
export async function findRiseBlocks(
  valueAt: (block: bigint) => Promise<number>,
  from: bigint,
  fromValue: number,
  to: bigint,
  toValue: number,
  out: bigint[],
  limit = MAX_BLOCKS_PER_POLL,
): Promise<void> {
  if (toValue <= fromValue || out.length >= limit) return;
  if (to - from <= 1n) {
    out.push(to);
    return;
  }
  const mid = from + (to - from) / 2n;
  const midValue = await valueAt(mid);
  await findRiseBlocks(valueAt, from, fromValue, mid, midValue, out, limit);
  await findRiseBlocks(valueAt, mid, midValue, to, toValue, out, limit);
}

export function startCustodianWatcher(network: NetworkKey, onCreation: UntrackedCreationHandler): () => Promise<void> {
  const client = getPublicClient(network);
  const cursorKey = `custodian:${network}`;
  const status: CustodianWatchStatus = {
    network,
    startedAt: new Date(),
    custodians: 0,
    lastBlock: null,
    lastPollAt: null,
    deployments: 0,
    lastError: null,
    lastErrorAt: null,
  };
  statuses.set(network, status);

  // Counts known at block `head`; a custodian missing here gets its baseline on the next poll.
  let head: bigint | null = null;
  const counts = new Map<Address, number>();
  let failedPolls = 0;
  let lastSavedAt = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const countAt = (address: Address, blockNumber: bigint) => client.getTransactionCount({ address, blockNumber });

  // Contracts created in `blockNumber` by, through or for a custodian.
  const scanBlock = async (blockNumber: bigint) => {
    const block = await client.getBlock({ blockNumber, includeTransactions: true });
    const txs = new Map(
      block.transactions.flatMap((tx) => (typeof tx === "object" ? [[tx.hash, tx] as const] : [])),
    );
    const label = (address: string | null | undefined) =>
      address ? custodianRepository.labelFor(network, address) : Promise.resolve(null);
    const emit = async (address: Address, from: Address, txHash: `0x${string}`, input: `0x${string}`, custodianLabel: string) => {
      status.deployments++;
      logger.info({ network, contractAddress: address, custodian: custodianLabel, txHash }, "Custodian deployed a contract");
      await onCreation({ network, contractAddress: address, creatorAddress: from, txHash, blockNumber, input, custodianLabel });
    };

    // One trace of the block lists every creation, through any intermediary
    // (a multisig calling the factory included).
    const traced = await findBlockCreates(client, network, blockNumber);
    if (traced) {
      for (const c of traced) {
        const tx = txs.get(c.txHash);
        if (!tx) continue;
        const custodian = (await label(c.createdBy)) ?? (await label(tx.from)) ?? (await label(tx.to));
        if (custodian) await emit(c.address, tx.from as Address, c.txHash, c.input, custodian);
      }
      return;
    }

    // No block tracing on this endpoint: the custodian's own transactions,
    // and calls into a custodian factory, traced one by one.
    for (const tx of txs.values()) {
      const fromLabel = await label(tx.from);
      const toLabel = await label(tx.to);
      if (!fromLabel && !toLabel) continue;
      if (tx.to === null) {
        const address = getContractAddress({ from: tx.from as Address, nonce: BigInt(tx.nonce) });
        await emit(address, tx.from as Address, tx.hash, tx.input, fromLabel!);
        continue;
      }
      for (const c of await findFactoryCreatedContracts(client, network, tx.hash)) {
        const custodian = fromLabel ?? (await label(c.createdBy)) ?? toLabel!;
        await emit(c.address, tx.from as Address, tx.hash, c.input, custodian);
      }
    }
  };

  const poll = async () => {
    const addresses = (await custodianRepository.addressesOn(network)) as Address[];
    status.custodians = addresses.length;
    if (addresses.length === 0) {
      status.lastPollAt = new Date();
      return;
    }

    const latest = await client.getBlockNumber({ cacheTime: 0 });
    if (head === null) {
      // First poll: resume from the saved block when it isn't too old, so
      // deployments made while the bot was down are still found.
      const saved = await networkCursorRepository.get(cursorKey).catch(() => null);
      head = saved !== null && saved > 0n && saved <= latest && latest - saved <= MAX_CATCHUP_BLOCKS ? saved : latest;
    }
    if (latest < head) head = latest;
    const from = head;
    // Nothing new since the last poll, and every custodian has a baseline.
    if (latest === from && addresses.every((a) => counts.has(a))) {
      status.lastPollAt = new Date();
      return;
    }

    const now = await Promise.all(addresses.map((a) => countAt(a, latest)));
    // Blocks where a count rose, up to `end`: a custodian with more than
    // MAX_BLOCKS_PER_POLL of them (a launch burst) moves `end` back to just
    // before the first one left over, so every rise up to `end` is known and
    // the rest are picked up by the following polls.
    let end = latest;
    const rises: bigint[] = [];
    for (const [i, address] of addresses.entries()) {
      let before = counts.get(address);
      if (before === undefined) {
        // New to the watch (or just started): its count at `from` is the baseline.
        before = from === latest ? now[i]! : await countAt(address, from).catch(() => now[i]!);
      }
      const found: bigint[] = [];
      await findRiseBlocks((b) => countAt(address, b), from, before, latest, now[i]!, found, MAX_BLOCKS_PER_POLL + 1);
      if (found.length > MAX_BLOCKS_PER_POLL && found[MAX_BLOCKS_PER_POLL]! - 1n < end) end = found[MAX_BLOCKS_PER_POLL]! - 1n;
      rises.push(...found);
    }
    let blocks = [...new Set(rises)].filter((b) => b <= end).sort((a, b) => (a < b ? -1 : 1));
    if (blocks.length > MAX_BLOCKS_PER_POLL) {
      end = blocks[MAX_BLOCKS_PER_POLL]! - 1n;
      blocks = blocks.slice(0, MAX_BLOCKS_PER_POLL);
    }
    for (const b of blocks) await scanBlock(b);

    const ends = end === latest ? now : await Promise.all(addresses.map((a) => countAt(a, end)));
    addresses.forEach((a, i) => counts.set(a, ends[i]!));
    for (const a of [...counts.keys()]) if (!addresses.includes(a)) counts.delete(a);
    head = end;
    status.lastBlock = end;
    status.lastPollAt = new Date();
    if (Date.now() - lastSavedAt >= CURSOR_SAVE_INTERVAL_MS) {
      lastSavedAt = Date.now();
      await networkCursorRepository.save(cursorKey, end).catch((err) => logger.warn({ err, network }, "Failed to save custodian cursor"));
    }
  };

  const loop = async () => {
    try {
      await poll();
      failedPolls = 0;
    } catch (err) {
      failedPolls++;
      status.lastError = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
      status.lastErrorAt = new Date();
      logger.warn({ err, network, failedPolls }, "Custodian watch poll failed");
      if (failedPolls >= MAX_FAILED_POLLS) {
        logger.error({ network }, "Custodian watch: repeated failures — restarting from the chain head");
        head = null;
        counts.clear();
        failedPolls = 0;
        await networkCursorRepository.save(cursorKey, 0n).catch(() => undefined);
      }
    }
    if (!stopped) timer = setTimeout(() => (running = loop()), env.CUSTODIAN_POLL_MS);
  };
  running = loop();
  logger.info({ network, pollMs: env.CUSTODIAN_POLL_MS }, "Started RWA custodian watch");

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
    if (head !== null) await networkCursorRepository.save(cursorKey, head).catch(() => undefined);
  };
}
