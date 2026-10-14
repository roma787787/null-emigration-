import { isAddressEqual, type Address } from "viem";
import type { MigrationTerms, NetworkKey } from "../types/index.js";
import { getNetwork } from "../config/networks.js";
import { getContractVerification } from "../chain/ownerDiscovery.js";
import { logger } from "../utils/logger.js";

/**
 * Where to migrate from a wallet right away:
 *  - the migration contract's "Write Contract" tab on the explorer, when its
 *    source is verified (call migrate()/convert() there — after approve on
 *    the old token's own tab);
 *  - the project's site, as listed in the token's DexScreener profile (set by
 *    the project for that token address) — new token first, else the old one.
 * Either is left out when it can't be had.
 */

const dexscreenerApi = () => process.env.DEXSCREENER_API_URL || "https://api.dexscreener.com";

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string };
  info?: { websites?: Array<{ label?: string; url?: string }> };
}

/** The site a token's DexScreener profile names: one labelled "Website" first, else the first https link. */
export function siteFromPairs(pairs: DexPair[], chainSlug: string, token: Address): string | null {
  for (const pair of pairs) {
    if (pair.chainId !== chainSlug || !pair.baseToken?.address) continue;
    if (!isAddressEqual(pair.baseToken.address as Address, token)) continue;
    const sites = (pair.info?.websites ?? []).filter((w) => typeof w.url === "string" && /^https:\/\/[^\s]+$/.test(w.url));
    const site = sites.find((w) => /web\s*site|^site$|official|app/i.test(w.label ?? "")) ?? sites[0];
    if (site?.url) return site.url;
  }
  return null;
}

export async function projectSite(network: NetworkKey, tokens: Address[]): Promise<string | null> {
  if (process.env.DEXSCREENER_API_URL === "off" || tokens.length === 0) return null;
  try {
    const res = await fetch(`${dexscreenerApi()}/latest/dex/tokens/${tokens.join(",")}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const pairs = ((await res.json()) as { pairs?: DexPair[] | null }).pairs ?? [];
    const slug = getNetwork(network).dexscreenerSlug;
    for (const token of tokens) {
      const site = siteFromPairs(pairs, slug, token);
      if (site) return site;
    }
    return null;
  } catch (err) {
    logger.debug({ err, network }, "DexScreener profile lookup failed");
    return null;
  }
}

/** The explorer tab where the migration function can be called from a wallet. */
export function writeContractUrl(network: NetworkKey, contract: Address, proxy: boolean): string {
  return `${getNetwork(network).explorerAddressUrl(contract)}#${proxy ? "writeProxyContract" : "writeContract"}`;
}

export async function readProjectLinks(
  network: NetworkKey,
  contract: Address,
  tokenA: Address | null,
  tokenB: Address | null,
): Promise<NonNullable<MigrationTerms["links"]>> {
  // The new token's profile first (often none yet), then the old one's.
  const tokens = [tokenB, tokenA].filter((t): t is Address => !!t);
  const [verification, website] = await Promise.all([
    getContractVerification(network, contract).catch(() => null),
    projectSite(network, [...new Set(tokens)]),
  ]);
  return {
    migrate: verification?.verified ? writeContractUrl(network, contract, verification.proxy) : null,
    website,
  };
}
