import { getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from "viem";

/**
 * Public getter names commonly used by migration contracts to expose the
 * destination token address (section 4.3.3 of the spec).
 */
const TOKEN_B_GETTERS = ["newToken", "destinationToken", "tokenB", "migratedToken", "token", "targetToken"] as const;

const GETTER_ABI = TOKEN_B_GETTERS.map((name) => ({
  type: "function" as const,
  name,
  stateMutability: "view" as const,
  inputs: [],
  outputs: [{ type: "address" as const }],
}));

export interface StaticCallProbeResult {
  tokenBAddress: Address | null;
  matchedGetter: string | null;
}

/**
 * Calls each known "destination token" getter on the freshly deployed
 * contract and returns the first one that resolves to a non-zero address.
 */
export async function probeForTokenB(client: PublicClient, contractAddress: Address): Promise<StaticCallProbeResult> {
  for (const name of TOKEN_B_GETTERS) {
    try {
      const result = await client.readContract({
        address: contractAddress,
        abi: GETTER_ABI,
        functionName: name,
      });
      if (typeof result === "string" && !isAddressEqual(result as Address, zeroAddress)) {
        return { tokenBAddress: getAddress(result), matchedGetter: name };
      }
    } catch {
      // Getter not implemented — expected for most contracts.
    }
  }

  return { tokenBAddress: null, matchedGetter: null };
}

/**
 * Secondary getters that don't identify Token B on their own but are still
 * evidence of migration/exchange logic (spec section 4.3.3): `oldToken()`
 * usually mirrors Token A, `rate()` an exchange ratio. Their mere presence
 * (the call not reverting) counts as a signal, regardless of the value.
 */
const AUXILIARY_ABI = [
  { type: "function", name: "oldToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "rate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export async function probeAuxiliarySignals(client: PublicClient, contractAddress: Address): Promise<string[]> {
  const matched: string[] = [];

  for (const name of ["oldToken", "rate"] as const) {
    try {
      await client.readContract({ address: contractAddress, abi: AUXILIARY_ABI, functionName: name });
      matched.push(name);
    } catch {
      // Getter not implemented.
    }
  }

  return matched;
}
