import { isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import type { NetworkKey } from "../types/index.js";
import { getPublicClient } from "./provider.js";
import { findBlockCreates, findFactoryCreatedContracts } from "./traceCreateDetector.js";
import { getContractCreation } from "./ownerDiscovery.js";
import { logger } from "../utils/logger.js";

const hasCode = (code: Hex | undefined) => !!code && code !== "0x";

/**
 * The first block in which `address` has code: bisection over eth_getCode
 * at past blocks (~log2(head) calls — 26 on Base). Needs an archive RPC
 * (Alchemy is one); null when the address has no code now.
 */
export async function findDeployBlock(client: PublicClient, address: Address, head?: bigint): Promise<bigint | null> {
  const top = head ?? (await client.getBlockNumber());
  if (!hasCode(await client.getCode({ address, blockNumber: top }))) return null;
  let lo = 0n;
  let hi = top;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (hasCode(await client.getCode({ address, blockNumber: mid }))) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** The transaction of block `blockNumber` that created `address` — directly or through a factory. */
export async function findCreatingTx(
  client: PublicClient,
  network: NetworkKey,
  address: Address,
  blockNumber: bigint,
): Promise<Hex | null> {
  // One trace of the block, where the endpoint offers it.
  const traced = await findBlockCreates(client, network, blockNumber);
  const hit = traced?.find((c) => isAddressEqual(c.address, address));
  if (hit) return hit.txHash;

  const block = await client.getBlock({ blockNumber, includeTransactions: true });
  const txs = block.transactions.flatMap((tx) => (typeof tx === "object" ? [tx] : []));
  // A direct deployment: its receipt names the contract.
  for (const tx of txs.filter((t) => t.to === null)) {
    const receipt = await client.getTransactionReceipt({ hash: tx.hash });
    if (receipt.contractAddress && isAddressEqual(receipt.contractAddress, address)) return tx.hash;
  }
  // Through a factory, without block tracing: each call traced on its own.
  if (!traced) {
    for (const tx of txs.filter((t) => t.to !== null)) {
      const creates = await findFactoryCreatedContracts(client, network, tx.hash);
      if (creates.some((c) => isAddressEqual(c.address, address))) return tx.hash;
    }
  }
  return null;
}

/**
 * The transaction that deployed `address`: the explorer API first (one call),
 * else found on-chain — the block where its code appeared, then the
 * transaction in it that created it. The on-chain path covers networks and
 * plans the explorer API doesn't.
 */
export async function findDeployTx(network: NetworkKey, address: Address): Promise<Hex | null> {
  const fromExplorer = await getContractCreation(network, address).catch(() => null);
  if (fromExplorer) return fromExplorer.txHash;
  try {
    const client = getPublicClient(network);
    const block = await findDeployBlock(client, address);
    if (block === null) return null;
    return await findCreatingTx(client, network, address, block);
  } catch (err) {
    logger.warn({ err, network, address }, "Deploy transaction lookup over RPC failed");
    return null;
  }
}
