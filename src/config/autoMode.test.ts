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

test("trace mode: Ethereum traces whole blocks by default, other networks use calldata", async () => {
  const { env } = await import("./env.js");
  const saved = { mode: process.env.AUTO_TRACE_MODE, nets: process.env.AUTO_BLOCK_TRACE_NETWORKS };
  try {
    delete process.env.AUTO_TRACE_MODE;
    delete process.env.AUTO_BLOCK_TRACE_NETWORKS;
    assert.equal(env.autoTraceMode("ethereum"), "block");
    assert.equal(env.autoTraceMode("arbitrum"), "calldata");
    process.env.AUTO_BLOCK_TRACE_NETWORKS = "";
    assert.equal(env.autoTraceMode("ethereum"), "calldata");
    process.env.AUTO_BLOCK_TRACE_NETWORKS = "base";
    assert.equal(env.autoTraceMode("base"), "block");
    assert.equal(env.autoTraceMode("ethereum"), "calldata");
    process.env.AUTO_TRACE_MODE = "off";
    assert.equal(env.autoTraceMode("base"), "off");
    process.env.AUTO_TRACE_MODE = "block";
    assert.equal(env.autoTraceMode("arbitrum"), "block");
  } finally {
    for (const [k, v] of [["AUTO_TRACE_MODE", saved.mode], ["AUTO_BLOCK_TRACE_NETWORKS", saved.nets]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
