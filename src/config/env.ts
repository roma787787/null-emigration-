import "dotenv/config";
import type { NetworkKey } from "../types/index.js";

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Network key -> env var fragment, e.g. "polygon-zkevm" -> "POLYGON_ZKEVM" (as in RPC_POLYGON_ZKEVM). */
export function envKeyFor(network: NetworkKey): string {
  return network.toUpperCase().replace(/-/g, "_");
}

export const env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://tracker:tracker@localhost:5432/migration_tracker",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  BLOCK_POLL_INTERVAL_MS: Number(process.env.BLOCK_POLL_INTERVAL_MS ?? 3000),
  ENABLE_FACTORY_TRACE_DETECTION: process.env.ENABLE_FACTORY_TRACE_DETECTION !== "false",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  // Etherscan's unified multichain API (v2) — one key, `chainid` selects the
  // network. Covers deployer lookups on every network in networks.ts.
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY ?? "",

  rpcUrlsFor(network: NetworkKey): string[] {
    return parseList(process.env[`RPC_${envKeyFor(network)}`]);
  },

  /** Raw ENABLED_NETWORKS list; resolved against known networks in networks.ts. */
  enabledNetworksRaw(): string[] {
    return parseList(process.env.ENABLED_NETWORKS).map((k) => k.toLowerCase());
  },

  /**
   * Telegram chat/user IDs (as strings) that are administrators: they're
   * auto-approved on first contact and receive Approve/Reject requests for
   * every other chat that starts the bot.
   */
  adminChatIds(): string[] {
    return parseList(process.env.ADMIN_CHAT_IDS);
  },
};

export function assertTelegramConfigured(): string {
  return required("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN);
}
