import { TelegramError } from "telegraf";
import { logger } from "../utils/logger.js";

interface Launchable {
  launch(onLaunch: () => void): Promise<void>;
}

const MAX_DELAY_MS = 30_000;

function isPollingConflict(err: unknown): boolean {
  return err instanceof TelegramError && err.code === 409;
}

/**
 * Starts long polling, retrying while Telegram answers 409 Conflict — i.e.
 * another instance is still polling with the same token, which is normal for
 * a few seconds during a Railway redeploy while the old deployment drains.
 * Crashing on it instead would take the block listeners down with it and
 * burn through the platform's restart budget. Any other error is rethrown.
 */
export async function launchWithConflictRetry(
  bot: Launchable,
  onLaunch: () => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let launched = false;
  const onFirstLaunch = () => {
    if (launched) return;
    launched = true;
    onLaunch();
  };

  for (let attempt = 1; ; attempt++) {
    try {
      await bot.launch(onFirstLaunch);
      return;
    } catch (err) {
      if (!isPollingConflict(err)) throw err;
      const delayMs = Math.min(MAX_DELAY_MS, 2_000 * attempt);
      logger.warn(
        { attempt, delayMs },
        "Telegram 409: another instance is polling with this bot token (normal briefly during a redeploy) — retrying",
      );
      await sleep(delayMs);
    }
  }
}
