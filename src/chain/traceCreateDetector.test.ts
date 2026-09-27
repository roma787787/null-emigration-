import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { findFactoryCreatedContracts, traceDetectionStatus } from "./traceCreateDetector.js";

function clientFailing(times: number, error: () => Error): { client: PublicClient; calls: () => number } {
  let calls = 0;
  const client = {
    request: async () => {
      calls++;
      if (calls <= times) throw error();
      return { type: "CALL", calls: [{ type: "CREATE2", to: "0x1111111111111111111111111111111111111111", input: "0x" }] };
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls };
}

test("a transient failure is thrown (so the block is retried), not treated as unsupported", async () => {
  const { client } = clientFailing(1, () => new Error("timeout"));
  await assert.rejects(findFactoryCreatedContracts(client, "net-transient", "0x01"));
  assert.equal(traceDetectionStatus("net-transient"), "on");
  const found = await findFactoryCreatedContracts(client, "net-transient", "0x01");
  assert.equal(found.length, 1);
});

test("three failures in a row pause tracing for the network", async () => {
  const { client, calls } = clientFailing(10, () => new Error("timeout"));
  await assert.rejects(findFactoryCreatedContracts(client, "net-flaky", "0x01"));
  await assert.rejects(findFactoryCreatedContracts(client, "net-flaky", "0x01"));
  assert.deepEqual(await findFactoryCreatedContracts(client, "net-flaky", "0x01"), []);
  assert.equal(traceDetectionStatus("net-flaky"), "unavailable");
  await findFactoryCreatedContracts(client, "net-flaky", "0x01");
  assert.equal(calls(), 3, "no further RPC calls while paused");
});

test("'method not found' pauses tracing immediately", async () => {
  const { client } = clientFailing(10, () => Object.assign(new Error("wrapped"), { cause: { code: -32601 } }));
  assert.deepEqual(await findFactoryCreatedContracts(client, "net-nomethod", "0x01"), []);
  assert.equal(traceDetectionStatus("net-nomethod"), "unavailable");
});
