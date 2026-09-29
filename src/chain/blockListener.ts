import { getContractAddress, type Address } from "viem";
import type { ContractCreationEvent, NetworkKey } from "../types/index.js";
import { getPublicClient, networkHasWebSocket, resetWebSocketConnections } from "./provider.js";
import { ownerRepository } from "../db/repositories/ownerRepository.js";
import { networkCursorRepository } from "../db/repositories/networkCursorRepository.js";
import { initListenerStatus, recordListenerError } from "./listenerStatus.js";
import { carriesInitCode, findBlockCreates, findFactoryCreatedContracts } from "./traceCreateDetector.js";
import { custodianRepository } from "../db/repositories/custodianRepository.js";
import { noteBlockSeen, noteCreationSeen } from "./autoStats.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TrackedContractCreationEvent extends ContractCreationEvent {
  tokenIds: number[];
}

export type ContractCreationHandler = (event: TrackedContractCreationEvent) => void | Promise<void>;

/** A contract created by a wallet nobody tracks — auto-discovery material. */
export interface UntrackedContractCreationEvent extends ContractCreationEvent {
  /** Set when the deployer is a registered RWA custodian. */
  custodianLabel: string | null;
}
export type UntrackedCreationHandler = (event: UntrackedContractCreationEvent) => void | Promise<void>;

const CURSOR_AHEAD_LIMIT = 64n;

/**
 * Which blocks to process when head `head` arrives: everything after the
 * last processed block, but at most `maxCatchup` of the newest ones (a long
 * downtime would otherwise mean replaying hours of blocks before any live
 * alert). With no cursor yet, only the head itself.
 */
export function blockRange(
  lastProcessed: bigint | null,
  head: bigint,
  maxCatchup: number,
): { from: bigint; skipped: number } | null {
  // A cursor far ahead of the chain belongs to some other chain (a reset
  // devnet, a redefined custom network): start over from the head instead of
  // waiting forever for the chain to reach it.
  if (lastProcessed !== null && lastProcessed > head + CURSOR_AHEAD_LIMIT) lastProcessed = null;
  if (lastProcessed !== null && head <= lastProcessed) return null;
  const wanted = lastProcessed === null ? head : lastProcessed + 1n;
  const earliest = head - BigInt(Math.max(1, maxCatchup)) + 1n;
  return wanted < earliest ? { from: earliest, skipped: Number(earliest - wanted) } : { from: wanted, skipped: 0 };
}

const CURSOR_SAVE_INTERVAL_MS = 5_000;

// Watchdog: when no new head has arrived for STALL_MS, ask the chain for its
// head directly (the fallback transport reaches it over HTTP even if the
// WebSocket is dead). If the chain has moved on, the feed is stalled: catch up
// and restart it. Sparse chains that simply had no new block are left alone.
const WATCHDOG_INTERVAL_MS = 15_000;
const STALL_MS = 45_000;
const HEAD_TIMEOUT_MS = 15_000;

// With no tracked wallets at all there's nothing to match, so blocks aren't
// fetched (saves RPC quota); the answer is cached briefly across networks.
const OWNERS_CHECK_TTL_MS = 10_000;
let ownersCheck: { at: number; any: Promise<boolean> } | null = null;

function anyOwnersTracked(): Promise<boolean> {
  if (!ownersCheck || Date.now() - ownersCheck.at > OWNERS_CHECK_TTL_MS) {
    const any = ownerRepository.anyExists();
    ownersCheck = { at: Date.now(), any };
    any.catch(() => (ownersCheck = null));
  }
  return ownersCheck.any;
}

/**
 * Watches a single network for new blocks and reports contract deployments
 * originating from a tracked owner/deployer address (section 4.2 of the
 * spec). Covers two paths:
 *
 *  - direct EOA deployment (`tx.to === null`), via the tx receipt's
 *    `contractAddress`;
 *  - factory-mediated deployment (the owner calls a contract, which
 *    internally CREATEs/CREATE2s a new contract), via
 *    `debug_traceTransaction` when the RPC endpoint supports it — see
 *    traceCreateDetector.ts for the capability-detection/fallback behavior.
 *
 * When a `wss://` RPC is configured for this network, new blocks arrive via
 * a push `eth_subscribe` WebSocket subscription instead of polling — this is
 * what makes the spec's 5-10s alert-latency target achievable. Falls back to
 * HTTP polling (`BLOCK_POLL_INTERVAL_MS`) otherwise.
 *
 * Progress is saved per network (network_cursors), so after a restart the
 * listener first replays the blocks it missed (see blockRange).
 */
export function startBlockListener(
  network: NetworkKey,
  onContractCreation: ContractCreationHandler,
  /** Contracts from untracked deployers (auto-discovery); omitted = tracked wallets only. */
  onUntrackedCreation?: UntrackedCreationHandler,
): () => Promise<void> {
  const handlers: Handlers = { tracked: onContractCreation, untracked: onUntrackedCreation };
  const client = getPublicClient(network);
  const usesWebSocket = networkHasWebSocket(network);
  const status = initListenerStatus(network, usesWebSocket ? "websocket" : "polling");
  let lastProcessedBlock: bigint | null = null;
  let savedBlock: bigint | null = null;
  let lastSavedAt = 0;
  let stopped = false;

  const saveCursor = async (force: boolean) => {
    if (lastProcessedBlock === null || lastProcessedBlock === savedBlock) return;
    if (!force && Date.now() - lastSavedAt < CURSOR_SAVE_INTERVAL_MS) return;
    const block = lastProcessedBlock;
    lastSavedAt = Date.now();
    try {
      await networkCursorRepository.save(network, block);
      savedBlock = block;
    } catch (err) {
      logger.warn({ err, network }, "Failed to save block cursor");
    }
  };

  // Resume from the block the previous run finished, so nothing mined during
  // a redeploy/crash is missed.
  let processing: Promise<void> = networkCursorRepository
    .get(network)
    .then((cursor) => {
      lastProcessedBlock = savedBlock = cursor;
      status.lastProcessedBlock = cursor;
      if (cursor !== null) logger.info({ network, cursor: cursor.toString() }, "Resuming from saved block cursor");
    })
    .catch((err) => logger.warn({ err, network }, "Could not load block cursor; starting from the chain head"));

  let lastHeadAt = Date.now();
  const onBlockNumber = (blockNumber: bigint) => {
    lastHeadAt = Date.now();
    processing = processing.then(async () => {
      try {
        const range = blockRange(lastProcessedBlock, blockNumber, env.MAX_CATCHUP_BLOCKS);
        if (!range) return;
        if (range.skipped > 0) {
          status.skippedBlocks += range.skipped;
          logger.warn(
            { network, skipped: range.skipped, from: range.from.toString() },
            "Downtime longer than MAX_CATCHUP_BLOCKS — skipping the oldest missed blocks",
          );
        }
        const catchingUp = blockNumber - range.from > 1n;
        if (catchingUp) {
          logger.info({ network, blocks: (blockNumber - range.from + 1n).toString() }, "Catching up on missed blocks");
        }
        for (let bn = range.from; bn <= blockNumber && !stopped; bn++) {
          const ok = await processBlockWithRetry(network, bn, handlers);
          if (!ok) status.failedBlocks++;
          lastProcessedBlock = bn;
          status.lastProcessedBlock = bn;
          status.lastProcessedAt = new Date();
          await saveCursor(false);
        }
        if (catchingUp) await saveCursor(true);
      } catch (err) {
        // Never let the chain reject: every later block would be skipped.
        recordListenerError(network, err);
        logger.error({ err, network }, "Unexpected block listener failure");
      }
    });
  };
  const onError = (err: Error) => {
    recordListenerError(network, err);
    logger.error({ err, network }, "Block watcher error");
  };

  // viem types `poll` as a discriminated literal keyed off the client's
  // transport generic, which collapses to the polling-only variant once the
  // transport is built from a runtime array of mixed http()/webSocket()
  // transports (TS can't see into that array's contents at the type level).
  // watchBlockNumber's actual runtime behavior only cares about `poll`'s
  // runtime value (see viem's watchBlockNumber.js), so this is a type-level
  // limitation, not a real unsoundness — hence the narrow cast.
  const watchBlockNumber = client.watchBlockNumber as (args: {
    emitOnBegin: boolean;
    poll: boolean;
    pollingInterval?: number;
    onBlockNumber: typeof onBlockNumber;
    onError: typeof onError;
  }) => () => void;

  const watch = () =>
    watchBlockNumber({
      emitOnBegin: true,
      poll: !usesWebSocket,
      pollingInterval: env.BLOCK_POLL_INTERVAL_MS,
      onBlockNumber,
      onError,
    });
  let unwatch = watch();

  let checking = false;
  const watchdog = setInterval(async () => {
    if (stopped || checking || Date.now() - lastHeadAt < STALL_MS) return;
    checking = true;
    try {
      const head = await Promise.race([
        client.getBlockNumber({ cacheTime: 0 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("head request timed out")), HEAD_TIMEOUT_MS)),
      ]);
      if (stopped) return;
      if (lastProcessedBlock !== null && head <= lastProcessedBlock) {
        lastHeadAt = Date.now(); // quiet chain, feed is fine
        return;
      }
      status.restarts++;
      logger.warn(
        { network, head: head.toString(), lastProcessed: lastProcessedBlock?.toString() ?? null },
        "Block feed stalled — catching up and restarting it",
      );
      unwatch();
      if (usesWebSocket) resetWebSocketConnections(network);
      onBlockNumber(head);
      unwatch = watch();
    } catch (err) {
      // No head at all: the provider is down, or a WebSocket is open but dead
      // and holding requests up. Drop the sockets so the next tick starts fresh.
      recordListenerError(network, err);
      if (usesWebSocket) resetWebSocketConnections(network);
    } finally {
      checking = false;
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  logger.info({ network, mode: status.mode }, "Started block listener");

  // Stops watching, lets the block in flight finish, and persists the cursor.
  return async () => {
    clearInterval(watchdog);
    unwatch();
    stopped = true;
    await processing;
    await saveCursor(true);
  };
}

const BLOCK_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

// A transient RPC/Redis failure must not silently drop a block's deployments,
// so each block is retried with backoff before it's given up on.
interface Handlers {
  tracked: ContractCreationHandler;
  untracked: UntrackedCreationHandler | undefined;
}

async function processBlockWithRetry(network: NetworkKey, blockNumber: bigint, handlers: Handlers): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await processBlock(network, blockNumber, handlers);
      return true;
    } catch (err) {
      const delay = BLOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        recordListenerError(network, err);
        logger.error({ err, network, blockNumber: blockNumber.toString() }, "Giving up on block after retries");
        return false;
      }
      logger.warn({ err, network, blockNumber: blockNumber.toString(), attempt: attempt + 1 }, "Block processing failed, retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function processBlock(network: NetworkKey, blockNumber: bigint, handlers: Handlers) {
  const autoDiscovery = handlers.untracked !== undefined;
  if (!autoDiscovery && !(await anyOwnersTracked())) return;
  const client = getPublicClient(network);
  const block = await client.getBlock({ blockNumber, includeTransactions: true });

  const txs = block.transactions.filter((tx): tx is Exclude<typeof tx, string> => typeof tx === "object");
  if (txs.length === 0) return;
  noteBlockSeen(network);

  const uniqueSenders = [...new Set(txs.map((tx) => tx.from as Address))];
  const ownerMap = await ownerRepository.findTokenIdsForAddresses(uniqueSenders);
  if (!autoDiscovery && ownerMap.size === 0) return;
  const senderOf = new Map(txs.map((tx) => [tx.hash, tx.from as Address]));

  // With auto-discovery on, one trace of the whole block yields every
  // contract created in it, factory-made ones included.
  const traceMode = autoDiscovery && env.ENABLE_FACTORY_TRACE_DETECTION ? env.autoTraceMode(network) : "off";
  const traced = traceMode === "block" ? await findBlockCreates(client, network, blockNumber) : null;
  const seen = new Set<string>();

  const dispatch = async (
    contractAddress: Address,
    creator: Address,
    txHash: `0x${string}`,
    input: `0x${string}`,
    via?: string,
    createdBy?: Address,
  ) => {
    const key = contractAddress.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const event = { network, contractAddress, creatorAddress: creator, txHash, blockNumber, input };
    const tokenIds = ownerMap.get(creator.toLowerCase());
    if (tokenIds && tokenIds.length > 0) {
      logger.info({ network, contractAddress, creator, via, tokenIds }, "Tracked owner deployed a new contract");
      await handlers.tracked({ ...event, tokenIds });
      return;
    }
    if (!handlers.untracked) return;
    noteCreationSeen(network);
    // A custodian is recognised by the wallet sending the tx or by the factory
    // contract that ran the CREATE (e.g. Dinari's DShareFactory).
    const custodianLabel =
      (await custodianRepository.labelFor(network, creator)) ??
      (createdBy ? await custodianRepository.labelFor(network, createdBy) : null);
    await handlers.untracked({ ...event, custodianLabel });
  };

  if (traced) {
    for (const create of traced) {
      const creator = senderOf.get(create.txHash);
      if (creator) await dispatch(create.address, creator, create.txHash, create.input, "trace", create.createdBy);
    }
  }

  for (const tx of txs) {
    const tokenIds = ownerMap.get((tx.from as string).toLowerCase());
    const tracked = tokenIds !== undefined && tokenIds.length > 0;

    if (tx.to === null) {
      if (traced) continue; // the block trace already listed it
      if (tracked) {
        // Tracked deployers: confirm with the receipt (a reverted deploy creates nothing).
        const receipt = await client.getTransactionReceipt({ hash: tx.hash });
        if (receipt.contractAddress) await dispatch(receipt.contractAddress, tx.from as Address, tx.hash, tx.input);
      } else if (handlers.untracked) {
        // Everyone else: derive the address from sender + nonce — no extra
        // RPC call per deployment; a reverted one just has no code later.
        const address = getContractAddress({ from: tx.from as Address, nonce: BigInt(tx.nonce) });
        await dispatch(address, tx.from as Address, tx.hash, tx.input);
      }
      continue;
    }

    // A tracked wallet calling a factory: trace that transaction (unless the
    // whole block was already traced above).
    if (traced || !env.ENABLE_FACTORY_TRACE_DETECTION) continue;
    if (tracked) {
      const created = await findFactoryCreatedContracts(client, network, tx.hash);
      for (const { address, input } of created) await dispatch(address, tx.from as Address, tx.hash, input, "factory");
      continue;
    }
    // Auto-discovery in "calldata" mode: trace only calls that ship creation
    // code (CREATE2 deployers, clone factories) — not every block.
    if (traceMode !== "calldata" || !handlers.untracked || !carriesInitCode(tx.input)) continue;
    try {
      const created = await findFactoryCreatedContracts(client, network, tx.hash);
      for (const c of created) await dispatch(c.address, tx.from as Address, tx.hash, c.input, "factory", c.createdBy);
    } catch (err) {
      logger.warn({ err, network, txHash: tx.hash }, "Trace of a deploy-carrying call failed; skipping it");
    }
  }
}
