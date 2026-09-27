import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatStatus, type StatusReport } from "./status.js";

const now = Date.parse("2026-01-01T12:00:00Z");

const report: StatusReport = {
  uptimeSec: 3 * 3600 + 12 * 60,
  counts: { tokens: 5, owners: 12, contracts: 3 },
  queue: { waiting: 0, active: 1, delayed: 2, failed: 0 },
  networks: [
    {
      network: "ethereum",
      head: 1005n,
      trace: "on",
      listener: {
        mode: "websocket",
        startedAt: new Date(now - 3600_000),
        lastProcessedBlock: 1000n,
        lastProcessedAt: new Date(now - 8_000),
        skippedBlocks: 0,
        failedBlocks: 0,
        lastError: null,
        lastErrorAt: null,
      },
    },
    {
      network: "base",
      head: null,
      trace: "unavailable",
      listener: {
        mode: "polling",
        startedAt: new Date(now - 3600_000),
        lastProcessedBlock: null,
        lastProcessedAt: null,
        skippedBlocks: 40,
        failedBlocks: 2,
        lastError: "HTTP request failed.\nStatus: 429",
        lastErrorAt: new Date(now - 90_000),
      },
    },
    { network: "bsc", head: 1n, trace: "off", listener: undefined },
  ],
};

test("formats durations compactly", () => {
  assert.equal(formatDuration(8_000), "8s");
  assert.equal(formatDuration(90_000), "1m");
  assert.equal(formatDuration(3 * 3600_000 + 12 * 60_000), "3h 12m");
  assert.equal(formatDuration(50 * 3600_000), "2d 2h");
});

test("shows a healthy network with block, lag and trace state", () => {
  const text = formatStatus("en", report, now);
  assert.match(text, /🟢 ethereum · websocket · block 1000 · lag 5 · 8s ago · factory trace: on/);
  assert.match(text, /Uptime: 3h 12m/);
  assert.match(text, /re-checks scheduled 2/);
});

test("flags a stalled network with its problems, and a missing listener", () => {
  const text = formatStatus("en", report, now);
  assert.match(text, /🔴 base · polling · no blocks processed yet · factory trace: unavailable on this RPC/);
  assert.match(text, /skipped after downtime: 40/);
  assert.match(text, /failed blocks: 2/);
  assert.match(text, /last error 1m ago: HTTP request failed\.$/m);
  assert.match(text, /🔴 bsc · listener not running/);
});
