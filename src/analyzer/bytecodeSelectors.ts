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
