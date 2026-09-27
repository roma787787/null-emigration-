import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramError } from "telegraf";
import { launchWithConflictRetry } from "./launch.js";

const conflict = () =>
  new TelegramError({
    ok: false,
    error_code: 409,
    description: "Conflict: terminated by other getUpdates request",
  } as never);

const noSleep = async () => {};

test("retries through 409 conflicts until polling starts, logging 'started' once", async () => {
  let calls = 0;
  let startedLogs = 0;
  const bot = {
    async launch(onLaunch: () => void) {
      calls++;
      onLaunch();
      if (calls < 3) throw conflict();
    },
  };

  await launchWithConflictRetry(bot, () => startedLogs++, noSleep);

  assert.equal(calls, 3);
  assert.equal(startedLogs, 1);
});

test("backs off progressively between conflict retries", async () => {
  const delays: number[] = [];
  let calls = 0;
  const bot = {
    async launch() {
      if (++calls < 4) throw conflict();
    },
  };

  await launchWithConflictRetry(bot, () => {}, async (ms) => void delays.push(ms));

  assert.deepEqual(delays, [2_000, 4_000, 6_000]);
});

test("rethrows non-conflict errors instead of retrying forever", async () => {
  const bot = {
    async launch() {
      throw new TelegramError({ ok: false, error_code: 401, description: "Unauthorized" } as never);
    },
  };

  await assert.rejects(launchWithConflictRetry(bot, () => {}, noSleep), /401/);
});
