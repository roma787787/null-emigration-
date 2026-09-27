import { hexToString, type Address, type PublicClient } from "viem";

type Field = "symbol" | "name";

const stringAbi = (field: Field) =>
  [{ type: "function", name: field, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
const bytes32Abi = (field: Field) =>
  [{ type: "function", name: field, stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const;

const PRINTABLE = /^[\x20-\x7E]{1,32}$/;

/**
 * Reads an ERC-20 `symbol()` / `name()`, accepting both the standard
 * `string` return and the legacy `bytes32` one used by early tokens such as
 * MKR and SAI (which otherwise decode as garbage/revert and show "UNKNOWN").
 */
export async function readTokenText(client: PublicClient, address: Address, field: Field): Promise<string | null> {
  try {
    const value = await client.readContract({ address, abi: stringAbi(field), functionName: field });
    if (value) return value;
  } catch {
    // fall through to bytes32
  }
  try {
    const raw = await client.readContract({ address, abi: bytes32Abi(field), functionName: field });
    const text = hexToString(raw, { size: 32 }).replace(/\0+$/, "").trim();
    // A real bytes32 symbol/name is readable text; arbitrary 32-byte data
    // (e.g. a hash) is not, and must not pass as a token symbol.
    return PRINTABLE.test(text) ? text : null;
  } catch {
    return null;
  }
}

export function readTokenSymbol(client: PublicClient, address: Address): Promise<string | null> {
  return readTokenText(client, address, "symbol");
}
