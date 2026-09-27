import { createPublicClient, fallback, http, webSocket } from "viem";
import type { NetworkKey } from "../types/index.js";
import { getNetwork, rpcUrlsForNetwork } from "../config/networks.js";

function isWebSocketUrl(url: string): boolean {
  return url.startsWith("ws://") || url.startsWith("wss://");
}

function buildClient(network: NetworkKey) {
  const urls = rpcUrlsForNetwork(network);
  if (urls.length === 0) {
    throw new Error(
      `No RPC URL configured for network "${network}". Set RPC_${network.toUpperCase().replace(/-/g, "_")} in .env`,
    );
  }

  // WebSocket URLs sorted first so watchBlockNumber's transport-type
  // auto-detection (see blockListener.ts) picks subscription mode over polling.
  const sorted = [...urls].sort((a, b) => Number(isWebSocketUrl(b)) - Number(isWebSocketUrl(a)));

  const transport = fallback(
    sorted.map((url) =>
      isWebSocketUrl(url)
        ? webSocket(url, { timeout: 10_000, retryCount: 2 })
        : http(url, { timeout: 10_000, retryCount: 2 }),
    ),
  );

  return {
    client: createPublicClient({ chain: getNetwork(network).chain, transport }),
    hasWebSocket: sorted.some(isWebSocketUrl),
  };
}

type AppPublicClient = ReturnType<typeof buildClient>["client"];

const clients = new Map<NetworkKey, AppPublicClient>();
const webSocketAvailability = new Map<NetworkKey, boolean>();

/**
 * Returns a viem PublicClient backed by a fallback transport: if the primary
 * RPC errors out or times out, viem automatically retries against the next
 * configured URL. This is the "automatic failover to backup RPC nodes"
 * requirement from the spec (section 5, Fault tolerance).
 *
 * `wss://` URLs get a WebSocket transport (push-based `eth_subscribe`,
 * required for the sub-10s alert latency target); `http(s)://` URLs get a
 * polling HTTP transport.
 */
export function getPublicClient(network: NetworkKey): AppPublicClient {
  const cached = clients.get(network);
  if (cached) return cached;

  const { client, hasWebSocket } = buildClient(network);
  clients.set(network, client);
  webSocketAvailability.set(network, hasWebSocket);
  return client;
}

/** Whether this network has at least one wss:// RPC configured (getPublicClient must run first). */
export function networkHasWebSocket(network: NetworkKey): boolean {
  return webSocketAvailability.get(network) ?? false;
}
