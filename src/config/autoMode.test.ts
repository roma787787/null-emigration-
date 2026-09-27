import { test } from "node:test";
import assert from "node:assert/strict";
import { autoDiscoveryMode } from "./autoMode.js";

const OKX = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_API_PASSPHRASE"];

test("auto-discovery is paused (not burning RPC) until OKX keys are set", () => {
  for (const k of OKX) delete process.env[k];
  assert.equal(autoDiscoveryMode(), "paused-no-okx");
  for (const k of OKX) process.env[k] = "x";
  assert.equal(autoDiscoveryMode(), "on");
  for (const k of OKX) delete process.env[k];
});
