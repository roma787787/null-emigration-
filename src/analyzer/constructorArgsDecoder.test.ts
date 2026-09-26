import { test } from "node:test";
import assert from "node:assert/strict";
import { isAddress } from "viem";
import { extractAddressCandidatesFromConstructorArgs } from "./constructorArgsDecoder.js";

test("extracts an address-shaped trailing word", () => {
  const address = "ab".repeat(20); // 40 hex chars
  const word = "0".repeat(24) + address;
  const input = `0x600160015b${word}` as `0x${string}`;

  const candidates = extractAddressCandidatesFromConstructorArgs(input);

  assert.equal(candidates.length, 1);
  assert.ok(isAddress(candidates[0]!));
  assert.equal(candidates[0]!.toLowerCase(), `0x${address}`);
});

test("ignores words that aren't address-shaped (non-zero leading bytes)", () => {
  const notAnAddress = "1".repeat(64); // no 12 leading zero bytes
  const input = `0x6001${notAnAddress}` as `0x${string}`;

  assert.deepEqual(extractAddressCandidatesFromConstructorArgs(input), []);
});

test("ignores the zero address", () => {
  const zeroWord = "0".repeat(64);
  const input = `0x6001${zeroWord}` as `0x${string}`;

  assert.deepEqual(extractAddressCandidatesFromConstructorArgs(input), []);
});

test("dedupes repeated candidates and finds multiple distinct ones", () => {
  const addrA = "aa".repeat(20);
  const addrB = "bb".repeat(20);
  const wordA = "0".repeat(24) + addrA;
  const wordB = "0".repeat(24) + addrB;
  const input = `0x6001${wordA}${wordA}${wordB}` as `0x${string}`;

  const candidates = extractAddressCandidatesFromConstructorArgs(input).map((a) => a.toLowerCase());

  assert.deepEqual(candidates, [`0x${addrB}`, `0x${addrA}`]);
});

test("returns an empty array for input with no trailing 32-byte words", () => {
  assert.deepEqual(extractAddressCandidatesFromConstructorArgs("0x6001"), []);
});
