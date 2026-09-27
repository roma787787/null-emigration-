const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;
const EQ = 0x14;
const XOR = 0x18;
const DUP2 = 0x81;

const MAX_SELECTORS = 200;

/**
 * Extracts function selectors from a contract's dispatcher by walking the
 * opcodes (so PUSH data is never misread as code): a selector is a PUSH4
 * immediately compared with the calldata selector — `PUSH4 sel EQ` (solc),
 * `PUSH4 sel XOR` (Vyper), or with a DUP2 in between.
 */
export function extractDispatcherSelectors(bytecode: string): `0x${string}`[] {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const bytes = Buffer.from(hex, "hex");
  const found = new Set<string>();

  for (let i = 0; i < bytes.length && found.size < MAX_SELECTORS; i++) {
    const op = bytes[i]!;
    if (op < PUSH1 || op > PUSH32) continue;

    const size = op - PUSH1 + 1;
    if (op === PUSH4 && i + 5 < bytes.length) {
      const next = bytes[i + 5]!;
      const afterDup = next === DUP2 ? bytes[i + 6] : undefined;
      if (next === EQ || next === XOR || afterDup === EQ || afterDup === XOR) {
        found.add(`0x${bytes.subarray(i + 1, i + 5).toString("hex")}`);
      }
    }
    i += size;
  }

  return [...found] as `0x${string}`[];
}

const PUSH20 = 0x73;
const MAX_ADDRESS_CONSTANTS = 12;
const MIN_ADDRESS_VALUE = 2n ** 32n;
const ALL_FF = "f".repeat(40);

/**
 * Addresses hard-coded in runtime code: `address constant OLD = 0x...`
 * compiles to PUSH20, and `immutable` addresses set in the constructor are
 * spliced into the deployed code as PUSH32 words with 12 zero bytes. This is
 * how a migrator that exposes no getter still reveals its tokens. Small
 * values (precompiles, flags) and the 0xff..ff mask are skipped.
 */
export function extractAddressConstants(bytecode: string): `0x${string}`[] {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const bytes = Buffer.from(hex, "hex");
  const found = new Set<string>();

  for (let i = 0; i < bytes.length && found.size < MAX_ADDRESS_CONSTANTS; i++) {
    const op = bytes[i]!;
    if (op < PUSH1 || op > PUSH32) continue;
    const size = op - PUSH1 + 1;
    const data = bytes.subarray(i + 1, i + 1 + size);
    let candidate: string | null = null;
    if (op === PUSH20 && data.length === 20) candidate = data.toString("hex");
    else if (op === PUSH32 && data.length === 32 && data.subarray(0, 12).every((b) => b === 0)) candidate = data.subarray(12).toString("hex");
    if (candidate && candidate !== ALL_FF && BigInt(`0x${candidate}`) >= MIN_ADDRESS_VALUE) found.add(`0x${candidate}`);
    i += size;
  }
  return [...found] as `0x${string}`[];
}
