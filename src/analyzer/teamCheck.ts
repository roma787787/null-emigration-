import { getAddress, isAddressEqual, toFunctionSelector, zeroAddress, type Address, type PublicClient } from "viem";
import type { MigrationTerms, NetworkKey } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { getContractCreation } from "../chain/ownerDiscovery.js";
import { findDeployTx } from "../chain/creationLookup.js";

/**
 * Is the migration contract the old token's team's? The old token is the
 * thing with a real market, so a contract tied to its deployer or owner is
 * the project's own; one deployed by an unrelated fresh wallet is how fake
 * "v2" swaps that collect holders' tokens look.
 *
 * Tied = the contract's deployer or owner() is the old token's deployer or
 * owner(). "no" only means no such tie was found — a team deploying from a
 * new wallet looks the same — so the card says to check the announcement.
 */

const OWNER_GETTERS = ["owner()", "getOwner()", "admin()", "governance()"].map((sig) => toFunctionSelector(sig));

/** The first owner-like getter that answers with a non-zero address. */
export async function ownerOf(client: PublicClient, address: Address): Promise<Address | null> {
  for (const selector of OWNER_GETTERS) {
    try {
      const { data } = await client.call({ to: address, data: selector });
      if (!data || data.length !== 66) continue;
      const word = BigInt(data);
      if (word === 0n || word >= 2n ** 160n) continue;
      const owner = getAddress(`0x${word.toString(16).padStart(40, "0")}`);
      if (!isAddressEqual(owner, zeroAddress)) return owner;
    } catch {
      // not this getter
    }
  }
  return null;
}

const creators = new Map<string, Address | null>();

/** Who deployed `address`: the explorer, else the deploy transaction found on-chain. Cached. */
export async function creatorOf(network: NetworkKey, address: Address): Promise<Address | null> {
  const key = `${network}:${address.toLowerCase()}`;
  if (creators.has(key)) return creators.get(key)!;
  let creator: Address | null = null;
  const fromExplorer = await getContractCreation(network, address).catch(() => null);
  if (fromExplorer) creator = fromExplorer.creator;
  else {
    const hash = await findDeployTx(network, address).catch(() => null);
    if (hash) creator = (await getPublicClient(network).getTransaction({ hash }).catch(() => null))?.from ?? null;
  }
  creators.set(key, creator);
  return creator;
}

/** Whether `contract` ties to Token A's deployer or owner. */
export async function readTeamLink(
  network: NetworkKey,
  contract: Address,
  contractCreator: Address | null,
  tokenA: Address,
): Promise<NonNullable<MigrationTerms["team"]>> {
  const client = getPublicClient(network);
  const [creator, contractOwner, tokenCreator, tokenOwner] = await Promise.all([
    contractCreator ? Promise.resolve(contractCreator) : creatorOf(network, contract),
    ownerOf(client, contract),
    creatorOf(network, tokenA),
    ownerOf(client, tokenA),
  ]);
  const team = [tokenCreator, tokenOwner].filter((a): a is Address => a !== null);
  const ours = [creator, contractOwner].filter((a): a is Address => a !== null);
  if (team.length === 0 || ours.length === 0) return { verdict: "unknown" };
  if (creator && tokenCreator && isAddressEqual(creator, tokenCreator)) return { verdict: "yes", via: "deployer" };
  const tied = ours.some((a) => team.some((b) => isAddressEqual(a, b)));
  return tied ? { verdict: "yes", via: "owner" } : { verdict: "no" };
}
