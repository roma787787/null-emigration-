import { env, assertTelegramConfigured } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { startBlockListener } from "./chain/blockListener.js";
import { enqueueContractCreation, startContractCreationWorker } from "./queue/notificationQueue.js";
import { createBot, broadcastMigrationAlert } from "./telegram/bot.js";
import { logger } from "./utils/logger.js";

async function main() {
  const botToken = assertTelegramConfigured();

  await runMigrations();

  const bot = createBot(botToken);
  const worker = startContractCreationWorker(async (analyzed) => {
    await broadcastMigrationAlert(bot, analyzed);
  });

  const stopListeners = env.enabledNetworks().map((network) =>
    startBlockListener(network, async (event) => {
      await enqueueContractCreation(event).catch((err) => {
        logger.error({ err, network, contractAddress: event.contractAddress }, "Failed to enqueue analysis job");
      });
    }),
  );

  await bot.launch();
  logger.info({ networks: env.enabledNetworks() }, "Multi-EVM migration tracker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    bot.stop(signal);
    for (const stop of stopListeners) stop();
    await worker.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
