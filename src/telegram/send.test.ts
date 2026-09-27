import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramError, type Telegraf } from "telegraf";
import { sendWithRetry } from "./send.js";

function botFailing(errors: TelegramError[]) {
  let calls = 0;
  const bot = {
    telegram: {
      sendMessage: async () => {
        const err = errors[calls++];
        if (err) throw err;
        return {};
      },
    },
  } as unknown as Telegraf;
  return { bot, calls: () => calls };
}

test("waits out a 429 and delivers", async () => {
  const { bot, calls } = botFailing([new TelegramError({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } })]);
  const waits: number[] = [];
  await sendWithRetry(bot, 1, "hi", undefined, async (ms) => void waits.push(ms));
  assert.equal(calls(), 2);
  assert.deepEqual(waits, [2000]);
});

test("does not retry other errors (403: bot blocked)", async () => {
  const { bot, calls } = botFailing([new TelegramError({ error_code: 403, description: "Forbidden: bot was blocked by the user" })]);
  await assert.rejects(sendWithRetry(bot, 1, "hi", undefined, async () => undefined));
  assert.equal(calls(), 1);
});

test("gives up after repeated 429s", async () => {
  const flood = () => new TelegramError({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } });
  const { bot, calls } = botFailing([flood(), flood(), flood(), flood(), flood()]);
  await assert.rejects(sendWithRetry(bot, 1, "hi", undefined, async () => undefined));
  assert.equal(calls(), 4);
});
