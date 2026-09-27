import { getAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import type { NetworkKey, OwnerSource } from "../types/index.js";
import { getPublicClient } from "./provider.js";
import { getNetwork } from "../config/networks.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const ETHERSCAN_V2_API_URL = "https://api.etherscan.io/v2/api";

export interface DiscoveredOwner {
  address: Address;
  source: OwnerSource;
}

/**
 * Looks up the "Contract Creator" / tx.from of the token's deployment
 * transaction via Etherscan's unified multichain API (one API key, `chainid`
 * selects the network — covers every network in networks.ts, not just
 * Ethereum). Mirrors the "Contract Creator" field shown on a token's
 * Etherscan-family explorer page.
 *
 * Requires `ETHERSCAN_API_KEY` (see .env.example). Falls back to null when
 * unset — callers should still get owner()/admin() results from
 * getOnChainOwners().
 */
export async function getContractDeployer(network: NetworkKey, tokenAddress: Address): Promise<Address | null> {
  if (!env.ETHERSCAN_API_KEY) {
    logger.warn({ network }, "ETHERSCAN_API_KEY not configured, skipping deployer lookup");
    return null;
  }

  const url = new URL(ETHERSCAN_V2_API_URL);
  url.searchParams.set("chainid", String(getNetwork(network).chain.id));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getcontractcreation");
  url.searchParams.set("contractaddresses", tokenAddress);
  url.searchParams.set("apikey", env.ETHERSCAN_API_KEY);

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    logger.warn({ network, status: response.status }, "Explorer API request failed");
    return null;
  }

  const body = (await response.json()) as {
    status: string;
    result?: Array<{ contractCreator: string }>;
  };

  const creator = body.result?.[0]?.contractCreator;
  return creator ? getAddress(creator) : null;
}

const OWNER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "DEFAULT_ADMIN_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "getRoleMemberCount",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getRoleMember",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

const MAX_ROLE_MEMBERS = 25;

/**
 * Probes the token contract for owner()/getOwner()/admin() and, when the
 * contract implements AccessControlEnumerable, DEFAULT_ADMIN_ROLE members.
 * Each probe is independent and failures (function not present) are ignored.
 */
export async function getOnChainOwners(network: NetworkKey, tokenAddress: Address): Promise<DiscoveredOwner[]> {
  const client = getPublicClient(network);
  const found: DiscoveredOwner[] = [];

  const simpleGetters: Array<{ fn: "owner" | "getOwner" | "admin"; source: OwnerSource }> = [
    { fn: "owner", source: "owner" },
    { fn: "getOwner", source: "owner" },
    { fn: "admin", source: "admin" },
  ];

  for (const { fn, source } of simpleGetters) {
    try {
      const result = await client.readContract({
        address: tokenAddress,
        abi: OWNER_ABI,
        functionName: fn,
      });
      if (typeof result === "string" && !isAddressEqual(result as Address, zeroAddress)) {
        found.push({ address: getAddress(result), source });
      }
    } catch {
      // Function not implemented on this contract — expected for most tokens.
    }
  }

  try {
    const role = await client.readContract({
      address: tokenAddress,
      abi: OWNER_ABI,
      functionName: "DEFAULT_ADMIN_ROLE",
    });

    const count = await client.readContract({
      address: tokenAddress,
      abi: OWNER_ABI,
      functionName: "getRoleMemberCount",
      args: [role],
    });

    const memberCount = Math.min(Number(count), MAX_ROLE_MEMBERS);
    for (let i = 0; i < memberCount; i++) {
      try {
        const member = await client.readContract({
          address: tokenAddress,
          abi: OWNER_ABI,
          functionName: "getRoleMember",
          args: [role, BigInt(i)],
        });
        found.push({ address: getAddress(member), source: "default_admin_role" });
      } catch {
        break;
      }
    }
  } catch {
    // Contract does not implement AccessControlEnumerable.
  }

  return found;
}

export async function discoverAllOwners(network: NetworkKey, tokenAddress: Address): Promise<DiscoveredOwner[]> {
  const [deployer, onChain] = await Promise.all([
    getContractDeployer(network, tokenAddress).catch((err) => {
      logger.warn({ err, network, tokenAddress }, "Deployer lookup failed");
      return null;
    }),
    getOnChainOwners(network, tokenAddress).catch((err) => {
      logger.warn({ err, network, tokenAddress }, "On-chain owner lookup failed");
      return [] as DiscoveredOwner[];
    }),
  ]);

  const result = [...onChain];
  if (deployer) {
    result.push({ address: deployer, source: "deployer" });
  }

  const seen = new Set<string>();
  return result.filter((owner) => {
    const key = owner.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
