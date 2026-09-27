import { test } from "node:test";
import assert from "node:assert/strict";
import type { TokenOwnerRecord } from "../types/index.js";
import { newOwners } from "./ownerRefresh.js";

const existing: TokenOwnerRecord[] = [
  { id: 1, tokenId: 1, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: "owner", createdAt: new Date() },
];

test("keeps only wallets not linked yet, case-insensitively", () => {
  const added = newOwners(existing, [
    { address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", source: "deployer" },
    { address: "0xbBbBBBBBbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", source: "owner" },
  ]);
  assert.deepEqual(added, [{ address: "0xbBbBBBBBbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", source: "owner" }]);
});
