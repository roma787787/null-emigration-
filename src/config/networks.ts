import {
  arbitrum,
  avalanche,
  base,
  blast,
  bsc,
  linea,
  mainnet,
  optimism,
  polygon,
  polygonZkEvm,
  scroll,
  type Chain,
} from "viem/chains";
import type { NetworkKey } from "../types/index.js";
import { env } from "./env.js";

export interface NetworkConfig {
  key: NetworkKey;
  label: string;
  chain: Chain;
  /** Public fallback RPCs used only when no RPC_<NETWORK> env var is set. Replace with paid endpoints in production. */
  defaultRpcUrls: string[];
  explorerAddressUrl: (address: string) => string;
  explorerTxUrl: (txHash: string) => string;
  dexscreenerTokenUrl: (address: string) => string;
}

const dexscreenerChainSlug: Record<NetworkKey, string> = {
  ethereum: "ethereum",
  bsc: "bsc",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  "polygon-zkevm": "polygonzkevm",
};

function explorerUrls(baseUrl: string) {
  return {
    explorerAddressUrl: (address: string) => `${baseUrl}/address/${address}`,
    explorerTxUrl: (txHash: string) => `${baseUrl}/tx/${txHash}`,
  };
}

function dexscreenerUrl(networkKey: NetworkKey) {
  return (address: string) => `https://dexscreener.com/${dexscreenerChainSlug[networkKey]}/${address}`;
}

const rawConfigs: Record<NetworkKey, { label: string; chain: Chain; explorerBaseUrl: string; defaultRpcUrls: string[] }> = {
  ethereum: {
    label: "Ethereum",
    chain: mainnet,
    explorerBaseUrl: "https://etherscan.io",
    defaultRpcUrls: ["https://eth.llamarpc.com", "https://rpc.ankr.com/eth"],
  },
  bsc: {
    label: "BNB Smart Chain",
    chain: bsc,
    explorerBaseUrl: "https://bscscan.com",
    defaultRpcUrls: ["https://bsc-dataseed.binance.org", "https://rpc.ankr.com/bsc"],
  },
  arbitrum: {
    label: "Arbitrum One",
    chain: arbitrum,
    explorerBaseUrl: "https://arbiscan.io",
    defaultRpcUrls: ["https://arb1.arbitrum.io/rpc", "https://rpc.ankr.com/arbitrum"],
  },
  base: {
    label: "Base",
    chain: base,
    explorerBaseUrl: "https://basescan.org",
    defaultRpcUrls: ["https://mainnet.base.org", "https://rpc.ankr.com/base"],
  },
  optimism: {
    label: "Optimism",
    chain: optimism,
    explorerBaseUrl: "https://optimistic.etherscan.io",
    defaultRpcUrls: ["https://mainnet.optimism.io", "https://rpc.ankr.com/optimism"],
  },
  polygon: {
    label: "Polygon",
    chain: polygon,
    explorerBaseUrl: "https://polygonscan.com",
    defaultRpcUrls: ["https://polygon-rpc.com", "https://rpc.ankr.com/polygon"],
  },
  avalanche: {
    label: "Avalanche C-Chain",
    chain: avalanche,
    explorerBaseUrl: "https://snowtrace.io",
    defaultRpcUrls: ["https://api.avax.network/ext/bc/C/rpc", "https://rpc.ankr.com/avalanche"],
  },
  linea: {
    label: "Linea",
    chain: linea,
    explorerBaseUrl: "https://lineascan.build",
    defaultRpcUrls: ["https://rpc.linea.build"],
  },
  scroll: {
    label: "Scroll",
    chain: scroll,
    explorerBaseUrl: "https://scrollscan.com",
    defaultRpcUrls: ["https://rpc.scroll.io"],
  },
  blast: {
    label: "Blast",
    chain: blast,
    explorerBaseUrl: "https://blastscan.io",
    defaultRpcUrls: ["https://rpc.blast.io"],
  },
  "polygon-zkevm": {
    label: "Polygon zkEVM",
    chain: polygonZkEvm,
    explorerBaseUrl: "https://zkevm.polygonscan.com",
    defaultRpcUrls: ["https://zkevm-rpc.com"],
  },
};

export const networks: Record<NetworkKey, NetworkConfig> = Object.fromEntries(
  (Object.keys(rawConfigs) as NetworkKey[]).map((key) => {
    const raw = rawConfigs[key];
    return [
      key,
      {
        key,
        label: raw.label,
        chain: raw.chain,
        defaultRpcUrls: raw.defaultRpcUrls,
        ...explorerUrls(raw.explorerBaseUrl),
        dexscreenerTokenUrl: dexscreenerUrl(key),
      } satisfies NetworkConfig,
    ];
  }),
) as Record<NetworkKey, NetworkConfig>;

export function rpcUrlsForNetwork(key: NetworkKey): string[] {
  const configured = env.rpcUrlsFor(key);
  return configured.length > 0 ? configured : networks[key].defaultRpcUrls;
}

export function isKnownNetwork(key: string): key is NetworkKey {
  return key in networks;
}

export function allNetworkKeys(): NetworkKey[] {
  return Object.keys(networks) as NetworkKey[];
}
