import { assertTelegramConfigured } from "./config/env.js";
import { enabledNetworks, networkConfigErrors, unknownEnabledNetworks } from "./config/networks.js";
import { runMigrations } from "./db/migrate.js";
import { startBlockListener } from "./chain/blockListener.js";
import { enqueueContractCreation, startContractCreationWorker } from "./queue/notificationQueue.js";
import { startOwnerRefresh } from "./queue/ownerRefreshQueue.js";
import { createBot, broadcastMigrationAlert, notifyNewOwners } from "./telegram/bot.js";
import { launchWithConflictRetry } from "./telegram/launch.js";
import { logger } from "./utils/logger.js";

async function main() {
  const botToken = assertTelegramConfigured();

  await runMigrations();

  const bot = createBot(botToken);
  const worker = startContractCreationWorker(async (analyzed) => {
    await broadcastMigrationAlert(bot, analyzed);
  });

  for (const error of networkConfigErrors) {
    logger.error({ error }, "Skipping misconfigured custom network (EXTRA_NETWORKS)");
  }
  const unknown = unknownEnabledNetworks();
  if (unknown.length > 0) {
    logger.warn({ unknown }, "ENABLED_NETWORKS lists networks that don't exist — typo?");
  }

  // One network failing to start (bad RPC URL, etc.) must not stop the others.
  const started: string[] = [];
  const stopListeners: Array<() => Promise<void>> = [];
  for (const network of enabledNetworks()) {
    try {
      stopListeners.push(
        startBlockListener(network, async (event) => {
          await enqueueContractCreation(event).catch((err) => {
            logger.error({ err, network, contractAddress: event.contractAddress }, "Failed to enqueue analysis job");
          });
        }),
      );
      started.push(network);
    } catch (err) {
      logger.error({ err, network }, "Failed to start block listener for network");
    }
  }

  const ownerRefreshWorker = await startOwnerRefresh((result) => notifyNewOwners(bot, result)).catch((err) => {
    logger.error({ err }, "Failed to start periodic owner refresh");
    return null;
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    try {
      bot.stop(signal);
    } catch {
      // Telegraf throws if polling never started (e.g. still retrying a 409).
    }
    // Each listener finishes its current block and saves its cursor, so the
    // next start resumes exactly where this one stopped.
    await Promise.all(stopListeners.map((stop) => stop().catch(() => undefined)));
    await Promise.all([worker.close(), ownerRefreshWorker?.close()]);
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // launch() only resolves once polling stops, so anything after it would
  // never run while the bot is up — hence the onLaunch callback and the
  // signal handlers being registered first.
  await launchWithConflictRetry(bot, () => {
    logger.info({ networks: started }, "Multi-EVM migration tracker started");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
