import { getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from "viem";

const WORD_HEX_LENGTH = 64;
const MAX_TAIL_WORDS = 32;

/**
 * A contract creation transaction's `input` is [init bytecode][constructor
 * args, ABI-encoded]. Without the contract's source/ABI there is no reliable
 * boundary between the two — so this takes a heuristic approach used by
 * several open-source contract-creation scanners: read the input in 32-byte
 * words from the end, keep any word that is "address-shaped" (12 leading
 * zero bytes + 20 non-zero bytes), and verify each candidate on-chain by
 * checking it looks like an ERC-20 (implements symbol()/totalSupply()).
 *
 * This will occasionally miss constructors whose Token B argument isn't in
 * the last ~32 words, and can't be more precise without decompiling the
 * init bytecode — both explicitly out of scope for this pass.
 */
export function extractAddressCandidatesFromConstructorArgs(input: `0x${string}` | string): Address[] {
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  const wordCount = Math.min(Math.floor(hex.length / WORD_HEX_LENGTH), MAX_TAIL_WORDS);
  const candidates: Address[] = [];

  for (let i = 0; i < wordCount; i++) {
    const start = hex.length - (i + 1) * WORD_HEX_LENGTH;
    if (start < 0) break;
    const word = hex.slice(start, start + WORD_HEX_LENGTH);
    if (isAddressShapedWord(word)) {
      const address = getAddress(`0x${word.slice(24)}`);
      if (!isAddressEqual(address, zeroAddress) && !candidates.includes(address)) {
        candidates.push(address);
      }
    }
  }

  return candidates;
}

function isAddressShapedWord(word: string): boolean {
  const leadingZeros = word.slice(0, 24);
  const addressPart = word.slice(24);
  return /^0+$/.test(leadingZeros) && /^[0-9a-f]{40}$/.test(addressPart) && !/^0+$/.test(addressPart);
}

const ERC20_PROBE_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function looksLikeErc20(client: PublicClient, address: Address): Promise<boolean> {
  try {
    await client.readContract({ address, abi: ERC20_PROBE_ABI, functionName: "totalSupply" });
    await client.readContract({ address, abi: ERC20_PROBE_ABI, functionName: "symbol" });
    return true;
  } catch {
    return false;
  }
}

export async function findTokenBInConstructorArgs(
  client: PublicClient,
  input: `0x${string}` | string,
): Promise<Address | null> {
  const candidates = extractAddressCandidatesFromConstructorArgs(input);
  for (const candidate of candidates) {
    if (await looksLikeErc20(client, candidate)) {
      return candidate;
    }
  }
  return null;
}
