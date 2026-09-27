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
  // After a restart each listener replays the blocks it missed, from its saved
  // cursor, but never more than this many (older ones are skipped and logged).
  MAX_CATCHUP_BLOCKS: Number(process.env.MAX_CATCHUP_BLOCKS ?? 2000),
  // A contract detected without Token B is re-analyzed after each of these
  // delays (seconds): proxies are often initialized with the tokens a few
  // transactions after the deploy.
  RECHECK_DELAYS_SEC: parseList(process.env.RECHECK_DELAYS_SEC ?? "120,600,3600,21600")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0),
  // How often every tracked token's owners/admins are re-discovered, so an
  // ownership transfer to a new wallet or multisig is picked up. 0 disables.
  OWNER_REFRESH_INTERVAL_HOURS: Number(process.env.OWNER_REFRESH_INTERVAL_HOURS ?? 24),
  // Auto-discovery: analyze every contract created on the watched networks,
  // not only those deployed by tracked wallets.
  AUTO_DISCOVERY: process.env.AUTO_DISCOVERY !== "false",
  // Auto-discovered alerts go out only when OKX found a route for Token A
  // within the chat's liquidity level; "false" also sends unchecked ones.
  AUTO_REQUIRE_LIQUIDITY: process.env.AUTO_REQUIRE_LIQUIDITY !== "false",
  AUTO_CONCURRENCY: Number(process.env.AUTO_CONCURRENCY ?? 8),

  /** Networks auto-discovery runs on (it reads and traces every block — the costly part); empty = every enabled network. */
  autoDiscoveryNetworks(): string[] {
    return parseList(process.env.AUTO_DISCOVERY_NETWORKS).map((k) => k.toLowerCase());
  },
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  // Etherscan's unified multichain API (v2) — one key, `chainid` selects the
  // network. Covers deployer lookups on every network in networks.ts.
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY ?? "",
  // OpenChain-compatible 4-byte signature database used to name unverified
  // contracts' functions; "off" disables lookups.
  SIGNATURE_DB_URL: process.env.SIGNATURE_DB_URL ?? "https://api.4byte.sourcify.dev/signature-database/v1/lookup",

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
