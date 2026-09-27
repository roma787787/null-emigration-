import { TelegramError, type Telegraf } from "telegraf";

const MAX_RETRIES = 3;
const MAX_WAIT_SEC = 30;

type SendExtra = Parameters<Telegraf["telegram"]["sendMessage"]>[2];

/**
 * sendMessage that waits out Telegram's flood control (429 + retry_after)
 * instead of dropping the message — alerts to many chats at once can hit it.
 * Any other error (e.g. 403: the user blocked the bot) is thrown as is.
 */
export async function sendWithRetry(
  bot: Telegraf,
  chatId: string | number,
  text: string,
  extra?: SendExtra,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await bot.telegram.sendMessage(chatId, text, extra);
      return;
    } catch (err) {
      const retryAfter = err instanceof TelegramError && err.code === 429 ? err.parameters?.retry_after : undefined;
      if (retryAfter === undefined || attempt >= MAX_RETRIES) throw err;
      await sleep(Math.min(retryAfter, MAX_WAIT_SEC) * 1000);
    }
  }
}
