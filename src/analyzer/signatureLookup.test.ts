import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSignature } from "./signatureLookup.js";

test("picks the first non-filtered signature", () => {
  assert.equal(
    pickSignature([
      { name: "spam_junk_xyz(uint256)", filtered: true },
      { name: "migrate(uint256)", filtered: false },
    ]),
    "migrate(uint256)",
  );
});

test("returns null for missing or fully filtered entries", () => {
  assert.equal(pickSignature(undefined), null);
  assert.equal(pickSignature(null), null);
  assert.equal(pickSignature([{ name: "x()", filtered: true }]), null);
});
