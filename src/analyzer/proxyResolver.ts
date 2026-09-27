import {
  getAddress,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  toBytes,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

function eip1967Slot(label: string): Hex {
  return toHex(hexToBigInt(keccak256(toBytes(label))) - 1n, { size: 32 });
}

const IMPLEMENTATION_SLOT = eip1967Slot("eip1967.proxy.implementation");
const BEACON_SLOT = eip1967Slot("eip1967.proxy.beacon");

// EIP-1167 minimal proxy ("clone"): the implementation address is inlined.
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

const BEACON_ABI = [
  { type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

function addressFromSlot(value: Hex | undefined): Address | null {
  if (!value || hexToBigInt(value) === 0n) return null;
  const address = getAddress(`0x${value.slice(-40)}`);
  return isAddressEqual(address, zeroAddress) ? null : address;
}

/**
 * Finds the implementation behind a proxy — EIP-1167 clone, EIP-1967
 * transparent/UUPS proxy, or EIP-1967 beacon proxy — or null for a regular
 * contract. Real migrators are often deployed behind proxies, where the
 * proxy's own bytecode is a generic delegatecall stub with none of the
 * migrate()/swap() selectors, so the implementation must be scanned too.
 */
export async function findProxyImplementation(
  client: PublicClient,
  proxyAddress: Address,
  proxyCode: Hex,
): Promise<Address | null> {
  const clone = MINIMAL_PROXY.exec(proxyCode);
  if (clone?.[1]) return getAddress(`0x${clone[1]}`);

  const implementation = addressFromSlot(await client.getStorageAt({ address: proxyAddress, slot: IMPLEMENTATION_SLOT }));
  if (implementation) return implementation;

  const beacon = addressFromSlot(await client.getStorageAt({ address: proxyAddress, slot: BEACON_SLOT }));
  if (beacon) {
    return client
      .readContract({ address: beacon, abi: BEACON_ABI, functionName: "implementation" })
      .then((impl) => (isAddressEqual(impl, zeroAddress) ? null : getAddress(impl)))
      .catch(() => null);
  }

  return null;
}
