import { test } from "node:test";
import assert from "node:assert/strict";
import { toggleNetworkFilter } from "./settingsView.js";
import { allNetworkKeys } from "../../config/networks.js";

test("toggling a network off from the implicit 'all' state excludes just that one", () => {
  const result = toggleNetworkFilter(null, "arbitrum");
  assert.ok(result);
  assert.ok(!result!.includes("arbitrum"));
  assert.equal(result!.length, allNetworkKeys().length - 1);
});

test("toggling the same network back on collapses back to 'all' (null)", () => {
  const withoutArbitrum = toggleNetworkFilter(null, "arbitrum");
  const restored = toggleNetworkFilter(withoutArbitrum, "arbitrum");
  assert.equal(restored, null);
});

test("toggling a network on from an explicit subset adds it", () => {
  const result = toggleNetworkFilter(["ethereum"], "bsc");
  assert.deepEqual(new Set(result), new Set(["ethereum", "bsc"]));
});

test("toggling a network off from an explicit subset removes it", () => {
  const result = toggleNetworkFilter(["ethereum", "bsc"], "bsc");
  assert.deepEqual(result, ["ethereum"]);
});
