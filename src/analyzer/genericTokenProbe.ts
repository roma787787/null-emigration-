import { getAddress, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { readTokenSymbol } from "../chain/tokenMetadata.js";

const MAX_CALLS = 60;
const MAX_CANDIDATES = 10;
const CONCURRENCY = 8;

const TOTAL_SUPPLY_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// Getters returning small integers (a version, a ratio, a count) look like
// addresses such as 0x...03 — precompiles that answer any call — so every
// value below this bound is treated as a number, not a token.
const MIN_ADDRESS_VALUE = 2n ** 32n;

// LP tokens (e.g. a DEX pair a new token creates) are ERC-20s but never a migration target.
const LP_SYMBOL = /UNI-V2|Cake-LP|SLP|(^|-)LP(-|$)/i;
const NEW_HINT = /new|target|dest|migrated|next|upgraded|v2|to$/i;
const OLD_HINT = /old|from|legacy|prev|v1/i;

export interface GenericProbeResult {
  tokenBAddress: Address;
  /** Getter name when the signature DB knows it (e.g. "polygonEcosystemToken"), else the raw selector. */
  getter: string;
}

function takesNoArguments(signature: string | undefined): boolean {
  return signature === undefined || signature.endsWith("()");
}

function addressFromReturn(data: Hex | undefined): Address | null {
  if (!data || data.length !== 66 || !/^0x0{24}/.test(data)) return null;
  if (BigInt(data) < MIN_ADDRESS_VALUE) return null;
  return getAddress(`0x${data.slice(26)}`);
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

async function isErc20(client: PublicClient, address: Address): Promise<boolean> {
  try {
    // Precompiles and EOAs have no code but can still return data from eth_call.
    const code = await client.getCode({ address });
    if (!code || code === "0x") return false;
    await client.readContract({ address, abi: TOTAL_SUPPLY_ABI, functionName: "totalSupply" });
  } catch {
    return false;
  }
  const symbol = await readTokenSymbol(client, address);
  return symbol !== null && !LP_SYMBOL.test(symbol);
}

/**
 * Finds Token B without knowing the getter's name: calls every zero-argument
 * function in the contract's dispatcher and keeps results that are ERC-20
 * addresses other than Token A. Catches project-specific getters like
 * AAVE(), polygonEcosystemToken() or sky() that no fixed name list covers.
 * eth_call is a read-only simulation, so calling unknown functions is safe.
 */
export async function probeZeroArgTokenGetters(
  client: PublicClient,
  contractAddress: Address,
  selectors: Hex[],
  signatures: Map<string, string>,
  tokenAAddress: Address,
): Promise<GenericProbeResult | null> {
  // Known zero-arg getters first, then unnamed selectors; skip known functions with parameters.
  const ordered = selectors
    .filter((s) => takesNoArguments(signatures.get(s)))
    .sort((a, b) => Number(signatures.has(b)) - Number(signatures.has(a)))
    .slice(0, MAX_CALLS);

  const returns = await mapLimited(ordered, (selector) =>
    client
      .call({ to: contractAddress, data: selector })
      .then((r) => addressFromReturn(r.data))
      .catch(() => null),
  );

  const gettersByAddress = new Map<Address, string[]>();
  returns.forEach((address, i) => {
    if (!address || isAddressEqual(address, tokenAAddress) || isAddressEqual(address, contractAddress)) return;
    const signature = signatures.get(ordered[i]!);
    const label = signature ? signature.slice(0, -2) : ordered[i]!;
    gettersByAddress.set(address, [...(gettersByAddress.get(address) ?? []), label]);
  });

  const rank = (labels: string[]) =>
    labels.some((l) => NEW_HINT.test(l)) ? 0 : labels.some((l) => OLD_HINT.test(l)) ? 2 : 1;
  const candidates = [...gettersByAddress.entries()]
    .sort(([, a], [, b]) => rank(a) - rank(b))
    .slice(0, MAX_CANDIDATES);

  for (const [address, labels] of candidates) {
    if (await isErc20(client, address)) {
      return { tokenBAddress: address, getter: labels[0]! };
    }
  }
  return null;
}
