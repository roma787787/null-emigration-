import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { BUILTIN_CUSTODIANS, parseCustodianSeed } from "./custodianRepository.js";
import { isKnownNetwork } from "../../config/networks.js";

test("built-in custodians are valid addresses on known networks", () => {
  for (const c of BUILTIN_CUSTODIANS) {
    assert.ok(isKnownNetwork(c.network), c.network);
    assert.doesNotThrow(() => getAddress(c.address));
    assert.equal(c.address, c.address.toLowerCase());
  }
});

test("CUSTODIAN_DEPLOYERS parses network:address:label entries and skips junk", () => {
  assert.deepEqual(parseCustodianSeed("arbitrum:0xCBDF630A858E7D87B5B08D92968CA14CA0F8F556:Robinhood Onchain, bad, base:0x12:x"), [
    { network: "arbitrum", address: "0xcbdf630a858e7d87b5b08d92968ca14ca0f8f556", label: "Robinhood Onchain" },
  ]);
});
