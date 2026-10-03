import { defineChain, type Chain } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  blast,
  bsc,
  hyperEvm,
  linea,
  mainnet,
  optimism,
  polygon,
  polygonZkEvm,
  robinhood,
  scroll,
} from "viem/chains";
import type { NetworkKey } from "../types/index.js";
import { env, envKeyFor, parseList } from "./env.js";

export interface NetworkConfig {
  key: NetworkKey;
  label: string;
  chain: Chain;
  /** Declared via EXTRA_NETWORKS rather than built in. */
  custom: boolean;
  /** Free, keyless public RPCs (failover in order) used only when no RPC_<NETWORK> env var is set: no block tracing or archive history, so factory deployments, /backfill and /analyze <address> work best on a paid endpoint. */
  defaultRpcUrls: string[];
  explorerAddressUrl: (address: string) => string;
  explorerTxUrl: (txHash: string) => string;
  dexscreenerTokenUrl: (address: string) => string;
}

interface NetworkSpec {
  label: string;
  chain: Chain;
  /** null = no dedicated explorer; links fall back to Blockscan's cross-chain search. */
  explorerBaseUrl: string | null;
  dexscreenerSlug: string;
  defaultRpcUrls: string[];
}

const BUILTIN_SPECS: Record<string, NetworkSpec> = {
  ethereum: {
    label: "Ethereum",
    chain: mainnet,
    explorerBaseUrl: "https://etherscan.io",
    dexscreenerSlug: "ethereum",
    defaultRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  },
  bsc: {
    label: "BNB Smart Chain",
    chain: bsc,
    explorerBaseUrl: "https://bscscan.com",
    dexscreenerSlug: "bsc",
    defaultRpcUrls: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"],
  },
  arbitrum: {
    label: "Arbitrum One",
    chain: arbitrum,
    explorerBaseUrl: "https://arbiscan.io",
    dexscreenerSlug: "arbitrum",
    defaultRpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
  },
  base: {
    label: "Base",
    chain: base,
    explorerBaseUrl: "https://basescan.org",
    dexscreenerSlug: "base",
    defaultRpcUrls: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  },
  optimism: {
    label: "Optimism",
    chain: optimism,
    explorerBaseUrl: "https://optimistic.etherscan.io",
    dexscreenerSlug: "optimism",
    defaultRpcUrls: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
  },
  polygon: {
    label: "Polygon",
    chain: polygon,
    explorerBaseUrl: "https://polygonscan.com",
    dexscreenerSlug: "polygon",
    defaultRpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
  },
  avalanche: {
    label: "Avalanche C-Chain",
    chain: avalanche,
    explorerBaseUrl: "https://snowtrace.io",
    dexscreenerSlug: "avalanche",
    defaultRpcUrls: ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"],
  },
  linea: {
    label: "Linea",
    chain: linea,
    explorerBaseUrl: "https://lineascan.build",
    dexscreenerSlug: "linea",
    defaultRpcUrls: ["https://linea-rpc.publicnode.com", "https://rpc.linea.build"],
  },
  scroll: {
    label: "Scroll",
    chain: scroll,
    explorerBaseUrl: "https://scrollscan.com",
    dexscreenerSlug: "scroll",
    defaultRpcUrls: ["https://scroll-rpc.publicnode.com", "https://rpc.scroll.io"],
  },
  blast: {
    label: "Blast",
    chain: blast,
    explorerBaseUrl: "https://blastscan.io",
    dexscreenerSlug: "blast",
    defaultRpcUrls: ["https://blast-rpc.publicnode.com", "https://rpc.blast.io"],
  },
  "polygon-zkevm": {
    label: "Polygon zkEVM",
    chain: polygonZkEvm,
    explorerBaseUrl: "https://zkevm.polygonscan.com",
    dexscreenerSlug: "polygonzkevm",
    defaultRpcUrls: ["https://zkevm-rpc.com"],
  },
  hyperevm: {
    label: "HyperEVM",
    chain: hyperEvm,
    explorerBaseUrl: "https://hyperevmscan.io",
    dexscreenerSlug: "hyperevm",
    defaultRpcUrls: ["https://rpc.hyperliquid.xyz/evm"],
  },
  // Robinhood's own Arbitrum Orbit L2 (mainnet since July 2026), home of its
  // Stock Tokens. ~10 blocks/s: best watched for custodians only (CUSTODIAN_NETWORKS).
  robinhood: {
    label: "Robinhood Chain",
    chain: robinhood,
    explorerBaseUrl: "https://robinhoodchain.blockscout.com",
    dexscreenerSlug: "robinhood",
    defaultRpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  },
};

const NETWORK_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface CustomNetworkParseResult {
  specs: Record<string, NetworkSpec>;
  errors: string[];
}

/**
 * Reads extra networks from env vars so new EVM chains need no code change:
 *
 *   EXTRA_NETWORKS=sonic,mantle
 *   NETWORK_SONIC_CHAIN_ID=146                      (required)
 *   RPC_SONIC=wss://...,https://...                 (required)
 *   NETWORK_SONIC_NAME=Sonic                        (optional, defaults to the key)
 *   NETWORK_SONIC_EXPLORER=https://sonicscan.org    (optional, else Blockscan links)
 *   NETWORK_SONIC_DEXSCREENER=sonic                 (optional, defaults to the key)
 *
 * A misconfigured network is skipped and reported in `errors` rather than
 * crashing the bot, so one typo can't take down every other network.
 */
export function parseCustomNetworks(
  source: Record<string, string | undefined>,
  builtinKeys: string[],
): CustomNetworkParseResult {
  const specs: Record<string, NetworkSpec> = {};
  const errors: string[] = [];

  for (const rawKey of parseList(source.EXTRA_NETWORKS)) {
    const key = rawKey.toLowerCase();
    const prefix = `NETWORK_${envKeyFor(key)}`;

    if (!NETWORK_KEY_PATTERN.test(key)) {
      errors.push(`"${rawKey}": network key must be lowercase letters/digits/hyphens (max 24 chars)`);
      continue;
    }
    if (builtinKeys.includes(key) || specs[key]) {
      errors.push(`"${key}": already defined`);
      continue;
    }

    const chainId = Number(source[`${prefix}_CHAIN_ID`]);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      errors.push(`"${key}": ${prefix}_CHAIN_ID must be a positive integer`);
      continue;
    }

    const rpcUrls = parseList(source[`RPC_${envKeyFor(key)}`]);
    if (rpcUrls.length === 0) {
      errors.push(`"${key}": RPC_${envKeyFor(key)} is required for a custom network`);
      continue;
    }

    const explorer = source[`${prefix}_EXPLORER`]?.trim().replace(/\/+$/, "") || null;
    if (explorer && !/^https?:\/\//.test(explorer)) {
      errors.push(`"${key}": ${prefix}_EXPLORER must start with http:// or https://`);
      continue;
    }

    const label = source[`${prefix}_NAME`]?.trim() || key;
    specs[key] = {
      label,
      chain: defineChain({
        id: chainId,
        name: label,
        nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
        rpcUrls: { default: { http: rpcUrls.filter((u) => u.startsWith("http")) } },
      }),
      explorerBaseUrl: explorer,
      dexscreenerSlug: source[`${prefix}_DEXSCREENER`]?.trim() || key,
      defaultRpcUrls: [],
    };
  }

  return { specs, errors };
}

function toConfig(key: string, spec: NetworkSpec, custom: boolean): NetworkConfig {
  const explorer = spec.explorerBaseUrl ?? "https://blockscan.com";
  return {
    key,
    label: spec.label,
    chain: spec.chain,
    custom,
    defaultRpcUrls: spec.defaultRpcUrls,
    explorerAddressUrl: (address) => `${explorer}/address/${address}`,
    explorerTxUrl: (txHash) => `${explorer}/tx/${txHash}`,
    dexscreenerTokenUrl: (address) => `https://dexscreener.com/${spec.dexscreenerSlug}/${address}`,
  };
}

const customNetworks = parseCustomNetworks(process.env, Object.keys(BUILTIN_SPECS));

/** Problems found in EXTRA_NETWORKS config; logged at startup. */
export const networkConfigErrors: string[] = customNetworks.errors;

const registry = new Map<string, NetworkConfig>([
  ...Object.entries(BUILTIN_SPECS).map(([key, spec]) => [key, toConfig(key, spec, false)] as const),
  ...Object.entries(customNetworks.specs).map(([key, spec]) => [key, toConfig(key, spec, true)] as const),
]);

export function getNetwork(key: NetworkKey): NetworkConfig {
  const network = registry.get(key);
  if (!network) throw new Error(`Unknown network "${key}"`);
  return network;
}

export function isKnownNetwork(key: string): boolean {
  return registry.has(key);
}

export function allNetworkKeys(): NetworkKey[] {
  return [...registry.keys()];
}

export function rpcUrlsForNetwork(key: NetworkKey): string[] {
  const configured = env.rpcUrlsFor(key);
  return configured.length > 0 ? configured : getNetwork(key).defaultRpcUrls;
}

/**
 * Networks the scanner watches: ENABLED_NETWORKS when set (otherwise every
 * built-in network), plus every valid EXTRA_NETWORKS entry — declaring a
 * custom network is itself the opt-in, so it doesn't also need listing in
 * ENABLED_NETWORKS.
 */
export function enabledNetworks(): NetworkKey[] {
  const configured = env.enabledNetworksRaw();
  const selected = configured.length === 0 ? Object.keys(BUILTIN_SPECS) : configured.filter(isKnownNetwork);
  return [...new Set([...selected, ...Object.keys(customNetworks.specs)])];
}

/** ENABLED_NETWORKS entries that don't match any known network (likely typos). */
export function unknownEnabledNetworks(): string[] {
  return env.enabledNetworksRaw().filter((k) => !isKnownNetwork(k));
}
