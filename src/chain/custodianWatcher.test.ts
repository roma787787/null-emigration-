import { test } from "node:test";
import assert from "node:assert/strict";
import { findRiseBlocks } from "./custodianWatcher.js";

// A deployer's nonce per block: rises at the listed blocks.
function counter(riseAt: number[], start = 1) {
  const reads: bigint[] = [];
  const valueAt = async (block: bigint) => {
    reads.push(block);
    return start + riseAt.filter((b) => BigInt(b) <= block).length;
  };
  return { valueAt, reads, at: (block: number) => start + riseAt.filter((b) => b <= block).length };
}

test("findRiseBlocks pins each rise to its block", async () => {
  const c = counter([105, 106, 180, 180, 199]);
  const out: bigint[] = [];
  await findRiseBlocks(c.valueAt, 100n, c.at(100), 200n, c.at(200), out);
  assert.deepEqual(out, [105n, 106n, 180n, 199n]);
});

test("findRiseBlocks reads ~log2(range) counts per rise, not every block", async () => {
  const c = counter([777_777]);
  const out: bigint[] = [];
  await findRiseBlocks(c.valueAt, 0n, c.at(0), 1_000_000n, c.at(1_000_000), out);
  assert.deepEqual(out, [777_777n]);
  assert.ok(c.reads.length <= 21, `${c.reads.length} reads`);
});

test("findRiseBlocks: no rise, no reads", async () => {
  const c = counter([]);
  const out: bigint[] = [];
  await findRiseBlocks(c.valueAt, 10n, 1, 5000n, 1, out);
  assert.deepEqual(out, []);
  assert.equal(c.reads.length, 0);
});

test("findRiseBlocks stops at the limit, keeping the earliest rises", async () => {
  const c = counter([11, 12, 13, 14, 15, 16]);
  const out: bigint[] = [];
  await findRiseBlocks(c.valueAt, 10n, c.at(10), 20n, c.at(20), out, 3);
  assert.deepEqual(out, [11n, 12n, 13n]);
});
