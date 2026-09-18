import { createPublicClient, fallback, http, type PublicClient } from "viem";
import type { NetworkKey } from "../types/index.js";
import { networks, rpcUrlsForNetwork } from "../config/networks.js";

const clients = new Map<NetworkKey, PublicClient>();

/**
 * Returns a viem PublicClient backed by a fallback transport: if the primary
 * RPC errors out or times out, viem automatically retries against the next
 * configured URL. This is the "automatic failover to backup RPC nodes"
 * requirement from the spec (section 5, Fault tolerance).
 */
export function getPublicClient(network: NetworkKey): PublicClient {
  const cached = clients.get(network);
  if (cached) return cached;

  const urls = rpcUrlsForNetwork(network);
  if (urls.length === 0) {
    throw new Error(
      `No RPC URL configured for network "${network}". Set RPC_${network.toUpperCase().replace(/-/g, "_")} in .env`,
    );
  }

  const transport = fallback(
    urls.map((url) =>
      http(url, {
        timeout: 10_000,
        retryCount: 2,
      }),
    ),
  );

  const client = createPublicClient({
    chain: networks[network].chain,
    transport,
  });

  clients.set(network, client);
  return client;
}
