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
        restarts: 0,
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
        restarts: 1,
        lastError: "HTTP request failed.\nStatus: 429",
        lastErrorAt: new Date(now - 90_000),
      },
    },
    {
      // Sparse chain: no new block for minutes, but fully caught up.
      network: "polygon-zkevm",
      head: 500n,
      trace: "on",
      listener: {
        mode: "polling",
        startedAt: new Date(now - 3600_000),
        lastProcessedBlock: 500n,
        lastProcessedAt: new Date(now - 4 * 60_000),
        skippedBlocks: 0,
        failedBlocks: 0,
        restarts: 0,
        lastError: null,
        lastErrorAt: null,
      },
    },
    {
      // Just restarted: resumed from its cursor, no new block yet.
      network: "linea",
      head: 700n,
      trace: "on",
      listener: {
        mode: "polling",
        startedAt: new Date(now - 14_000),
        lastProcessedBlock: 700n,
        lastProcessedAt: null,
        skippedBlocks: 0,
        failedBlocks: 0,
        restarts: 0,
        lastError: null,
        lastErrorAt: null,
      },
    },
    {
      // Stuck far behind the head.
      network: "arbitrum",
      head: 100_000n,
      trace: "on",
      listener: {
        mode: "polling",
        startedAt: new Date(now - 3600_000),
        lastProcessedBlock: 50_000n,
        lastProcessedAt: new Date(now - 30 * 60_000),
        skippedBlocks: 0,
        failedBlocks: 0,
        restarts: 0,
        lastError: null,
        lastErrorAt: null,
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
  assert.match(text, /block feed restarted after a stall: 1/);
  assert.match(text, /last error 1m ago: HTTP request failed\.$/m);
  assert.match(text, /🔴 bsc · listener not running/);
});

test("judges health by lag: sparse and just-resumed chains are green, a stuck one red", () => {
  const text = formatStatus("en", report, now);
  assert.match(text, /🟢 polygon-zkevm · polling · block 500 · lag 0 · 4m ago/);
  assert.match(text, /🟢 linea · polling · block 700 · lag 0 · factory trace: on/);
  assert.match(text, /🔴 arbitrum · polling · block 50000 · lag 50000/);
});

test("RWA custodian watch lines: healthy, erroring, no custodians", () => {
  const base = { startedAt: new Date(now - 3600_000), deployments: 0, lastError: null, lastErrorAt: null };
  const text = formatStatus(
    "en",
    {
      ...report,
      custodians: [
        { ...base, network: "robinhood", custodians: 1, lastBlock: 9_000_000n, lastPollAt: new Date(now - 2_000), deployments: 3 },
        {
          ...base,
          network: "arbitrum",
          custodians: 2,
          lastBlock: 400n,
          lastPollAt: new Date(now - 5 * 60_000),
          lastError: "missing trie node",
          lastErrorAt: new Date(now - 10_000),
        },
        { ...base, network: "base", custodians: 0, lastBlock: null, lastPollAt: new Date(now - 1_000) },
      ],
    },
    now,
  );
  assert.match(text, /🏦 RWA custodian watch/);
  assert.match(text, /🟢 robinhood · custodians 1 · block 9000000 · polled 2s ago · deployments 3/);
  assert.match(text, /🔴 arbitrum · custodians 2 · block 400 · polled 5m ago · deployments 0\n    ↳ last error 10s ago: missing trie node/);
  assert.match(text, /⚪️ base · no custodians registered/);
});
