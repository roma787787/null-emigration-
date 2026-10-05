import { isAddressEqual, keccak256, toBytes, toHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import type { MigrationContractRecord, NetworkKey } from "../types/index.js";
import { getPublicClient } from "./provider.js";
import { migrationContractRepository } from "../db/repositories/migrationContractRepository.js";
import { termsFor } from "../analyzer/migrationTerms.js";
import { logger } from "../utils/logger.js";

/**
 * "Migration opened": the first exchange through an alerted migration
 * contract. The first alert says a migration is coming; this one says it is
 * live — the moment the old/new spread can be worked.
 *
 * Seen from logs, so it needs no tracing and works on any RPC:
 *  - the old token sent into the contract (Telcoin's TokenMigration keeps it),
 *  - the new token sent out by the contract (a pre-funded migrator),
 *  - the contract minting itself (it is the new token),
 *  - one of the migration events found in its code (Migrated, Converted…).
 */

const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
const topicOf = (address: Address): Hex => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

interface Log {
  transactionHash: Hex;
  blockNumber: Hex;
  logIndex: Hex;
}

export interface FirstExchange {
  txHash: Hex;
  blockNumber: bigint;
}

/** The earliest exchange through the contract in [fromBlock, toBlock], if any. */
export async function findFirstExchange(
  client: PublicClient,
  record: Pick<MigrationContractRecord, "contractAddress" | "tokenAAddress" | "tokenBAddress" | "matchedEvents">,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<FirstExchange | null> {
  const contract = record.contractAddress;
  const queries: { address: Address; topics: (Hex | Hex[] | null)[] }[] = [];
  if (record.tokenAAddress) queries.push({ address: record.tokenAAddress, topics: [TRANSFER, null, topicOf(contract)] });
  if (record.tokenBAddress && !isAddressEqual(record.tokenBAddress, contract)) {
    queries.push({ address: record.tokenBAddress, topics: [TRANSFER, topicOf(contract)] });
  }
  if (record.tokenBAddress && isAddressEqual(record.tokenBAddress, contract)) {
    queries.push({ address: contract, topics: [TRANSFER, topicOf(zeroAddress)] });
  }
  const events = record.matchedEvents.map((sig) => keccak256(toBytes(sig)));
  if (events.length > 0) queries.push({ address: contract, topics: [events] });

  const request = client.request as unknown as (args: { method: "eth_getLogs"; params: [object] }) => Promise<Log[]>;
  const results = await Promise.all(
    queries.map((q) => request({ method: "eth_getLogs", params: [{ ...q, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }] })),
  );
  const logs = results.flat();
  if (logs.length === 0) return null;
  const order = (l: Log) => BigInt(l.blockNumber) * 1_000_000n + BigInt(l.logIndex);
  const earliest = logs.reduce((a, b) => (order(b) < order(a) ? b : a));
  return { txHash: earliest.transactionHash, blockNumber: BigInt(earliest.blockNumber) };
}

export interface OpenWatchOptions {
  intervalMs?: number;
  /** How long after detection a contract is watched. */
  days?: number;
  /** Blocks per eth_getLogs call (public RPCs cap the range). */
  chunk?: number;
  /** Calls per contract per poll: how fast a watch that fell behind catches up. */
  maxChunks?: number;
}

export function openWatchOptionsFromEnv(): OpenWatchOptions {
  const num = (name: string) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return {
    intervalMs: num("OPEN_WATCH_INTERVAL_MS"),
    days: num("OPEN_WATCH_DAYS"),
    chunk: num("OPEN_WATCH_CHUNK_BLOCKS"),
    maxChunks: num("OPEN_WATCH_MAX_CHUNKS"),
  };
}

// getLogs range per contract, shrunk when an RPC refuses a range.
const chunks = new Map<number, bigint>();

/** One pass over a network's contracts awaiting their first exchange. */
export async function pollOpenings(
  network: NetworkKey,
  onOpened: (record: MigrationContractRecord) => Promise<void>,
  options: OpenWatchOptions = {},
): Promise<void> {
  const days = options.days ?? 30;
  const maxChunks = options.maxChunks ?? 10;
  const client = getPublicClient(network);
  const watched = await migrationContractRepository.listAwaitingOpen(network, days);
  if (watched.length === 0) return;
  const head = await client.getBlockNumber({ cacheTime: 0 });

  for (const record of watched) {
    let chunk = chunks.get(record.id) ?? BigInt(options.chunk ?? 2_000);
    // First pass: from the deploy — or, if the bot was down that long, a recent
    // window only: an exchange from weeks ago is not news.
    const start = record.cursor ?? (record.blockNumber > head - chunk ? record.blockNumber : head - chunk);
    let from = start + 1n;
    for (let i = 0; i < maxChunks && from <= head; i++) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head;
      let found: FirstExchange | null;
      try {
        found = await findFirstExchange(client, record, from, to);
      } catch (err) {
        // Most often a range the RPC won't serve: try a smaller one next time round.
        if (chunk > 100n) chunks.set(record.id, (chunk /= 4n));
        logger.warn({ err, network, contract: record.contractAddress, from: from.toString(), to: to.toString() }, "Open watch: getLogs failed");
        break;
      }
      if (found) {
        const terms = await termsFor(network, record.contractAddress, record.tokenAAddress, record.tokenBAddress);
        if (await migrationContractRepository.markOpened(record.id, found.txHash, found.blockNumber, terms)) {
          logger.info({ network, contract: record.contractAddress, tx: found.txHash }, "Migration opened");
          await onOpened({ ...record, terms: terms ?? record.terms, openedAt: new Date(), openedTx: found.txHash });
        }
        break;
      }
      await migrationContractRepository.setOpenCursor(record.id, to);
      from = to + 1n;
    }
  }
}

/** Polls a network's alerted contracts for their first exchange. Returns a stopper. */
export function startMigrationOpenWatcher(
  network: NetworkKey,
  onOpened: (record: MigrationContractRecord) => Promise<void>,
  options: OpenWatchOptions = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    running = pollOpenings(network, onOpened, options).catch((err) => {
      logger.warn({ err, network }, "Open watch pass failed");
    });
    await running;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, Math.min(intervalMs, 5_000));
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
