import type { NetworkKey } from "../types/index.js";
import { envKeyFor, parseList } from "./env.js";

export interface QuoteToken {
  address: string;
  decimals: number;
  symbol: string;
}

interface MarketSpec {
  /** Dollar stablecoin the liquidity test swaps from ($1,000 of it by default). */
  quote: QuoteToken;
  /** Wrapped native, major stables and bridged blue chips (WBTC, BTCB, Binance-Peg ETH): never a migration's old token, so auto-discovery ignores contracts whose Token A is one of them (DEX pools, routers). */
  baseAssets: string[];
}

// Addresses in lowercase: compared case-insensitively, never checksummed.
// Override per network with QUOTE_TOKEN_<NETWORK>=<address>:<decimals>[:<symbol>]
// and extend with BASE_ASSETS_<NETWORK>=<address>,<address>.
const SPECS: Record<string, MarketSpec> = {
  ethereum: {
    quote: { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, symbol: "USDT" },
    baseAssets: [
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
      "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
      "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
    ],
  },
  bsc: {
    quote: { address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18, symbol: "USDT" },
    baseAssets: [
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
      "0x55d398326f99059ff775485246999027b3197955", // USDT
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
      "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
      "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", // BTCB
      "0x2170ed0880ac9a755fd29b2688956bd959f933f8", // Binance-Peg ETH
    ],
  },
  arbitrum: {
    quote: { address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6, symbol: "USDT" },
    baseAssets: [
      "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
      "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", // WBTC
    ],
  },
  base: {
    // Base has little native USDT; USDC is its dollar of record.
    quote: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" },
    baseAssets: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
    ],
  },
  optimism: {
    quote: { address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6, symbol: "USDT" },
    baseAssets: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC
      "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // USDT
      "0x68f180fcce6836688e9084f035309e29bf0a2095", // WBTC
    ],
  },
  polygon: {
    quote: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6, symbol: "USDT" },
    baseAssets: [
      "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WPOL
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC
      "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
      "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
      "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
    ],
  },
  avalanche: {
    quote: { address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6, symbol: "USDt" },
    baseAssets: [
      "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
      "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC
      "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDt
    ],
  },
  linea: {
    quote: { address: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", decimals: 6, symbol: "USDC" },
    baseAssets: [
      "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", // WETH
      "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", // USDC
      "0xa219439258ca9da29e9cc4ce5596924745e12b93", // USDT
    ],
  },
  scroll: {
    quote: { address: "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4", decimals: 6, symbol: "USDC" },
    baseAssets: [
      "0x5300000000000000000000000000000000000004", // WETH
      "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4", // USDC
      "0xf55bec9cafdbe8730f096aa55dad6d22d44099df", // USDT
    ],
  },
  blast: {
    quote: { address: "0x4300000000000000000000000000000000000003", decimals: 18, symbol: "USDB" },
    baseAssets: [
      "0x4300000000000000000000000000000000000004", // WETH
      "0x4300000000000000000000000000000000000003", // USDB
    ],
  },
  "polygon-zkevm": {
    quote: { address: "0xa8ce8aee21bc2a48a5ef670afcc9274c7bbbc035", decimals: 6, symbol: "USDC" },
    baseAssets: [
      "0x4f9a0e7fd2bf6067db6994cf12e4495df938e6e9", // WETH
      "0xa8ce8aee21bc2a48a5ef670afcc9274c7bbbc035", // USDC.e
    ],
  },
  hyperevm: {
    quote: { address: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", decimals: 6, symbol: "USDT0" },
    baseAssets: [
      "0x5555555555555555555555555555555555555555", // WHYPE
      "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", // USDT0
    ],
  },
};

/** Parses QUOTE_TOKEN_<NETWORK> ("<address>:<decimals>[:<symbol>]"). */
export function parseQuoteToken(value: string | undefined): QuoteToken | null {
  if (!value) return null;
  const [address, decimals, symbol] = value.split(":").map((p) => p.trim());
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !decimals || !/^\d+$/.test(decimals)) return null;
  return { address: address.toLowerCase(), decimals: Number(decimals), symbol: symbol || "USD" };
}

export function quoteTokenFor(network: NetworkKey): QuoteToken | null {
  return parseQuoteToken(process.env[`QUOTE_TOKEN_${envKeyFor(network)}`]) ?? SPECS[network]?.quote ?? null;
}

export function baseAssetsFor(network: NetworkKey): Set<string> {
  const extra = parseList(process.env[`BASE_ASSETS_${envKeyFor(network)}`]).map((a) => a.toLowerCase());
  return new Set([...(SPECS[network]?.baseAssets ?? []), ...extra]);
}

export function isBaseAsset(network: NetworkKey, address: string): boolean {
  return baseAssetsFor(network).has(address.toLowerCase());
}
