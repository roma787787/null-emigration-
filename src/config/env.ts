import "dotenv/config";
import type { NetworkKey } from "../types/index.js";

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

const allNetworkKeys: NetworkKey[] = [
  "ethereum",
  "bsc",
  "arbitrum",
  "base",
  "optimism",
  "polygon",
  "avalanche",
  "linea",
  "scroll",
  "blast",
  "polygon-zkevm",
];

export const env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://tracker:tracker@localhost:5432/migration_tracker",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  BLOCK_POLL_INTERVAL_MS: Number(process.env.BLOCK_POLL_INTERVAL_MS ?? 3000),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY ?? "",
  BSCSCAN_API_KEY: process.env.BSCSCAN_API_KEY ?? "",
  ARBISCAN_API_KEY: process.env.ARBISCAN_API_KEY ?? "",

  rpcUrlsFor(network: NetworkKey): string[] {
    const envKey = `RPC_${network.toUpperCase().replace(/-/g, "_")}`;
    return parseList(process.env[envKey]);
  },

  enabledNetworks(): NetworkKey[] {
    const configured = parseList(process.env.ENABLED_NETWORKS);
    if (configured.length === 0) return allNetworkKeys;
    return configured.filter((k): k is NetworkKey => allNetworkKeys.includes(k as NetworkKey));
  },
};

export function assertTelegramConfigured(): string {
  return required("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN);
}
