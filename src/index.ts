import { assertTelegramConfigured } from "./config/env.js";
import { enabledNetworks, isKnownNetwork, networkConfigErrors, unknownEnabledNetworks } from "./config/networks.js";
import { runMigrations } from "./db/migrate.js";
import { startBlockListener, type UntrackedCreationHandler } from "./chain/blockListener.js";
import { startCustodianWatcher } from "./chain/custodianWatcher.js";
import {
  enqueueAutoCandidate,
  enqueueContractCreation,
  startAutoDiscoveryWorker,
  startContractCreationWorker,
} from "./queue/notificationQueue.js";
import { env } from "./config/env.js";
import { custodianRepository, parseCustodianSeed } from "./db/repositories/custodianRepository.js";
import { autoDiscoveryMode } from "./config/autoMode.js";
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
  const autoOn = autoDiscoveryMode() === "on";
  const autoCovers = (network: string) =>
    autoOn && (env.autoDiscoveryNetworks().length === 0 || env.autoDiscoveryNetworks().includes(network));
  // RWA custodians are watched wherever auto-discovery doesn't already read
  // every block: enabled networks without it, plus CUSTODIAN_NETWORKS.
  const custodianNetworks = env.CUSTODIAN_WATCH
    ? [...new Set([...enabledNetworks(), ...env.custodianNetworks().filter(isKnownNetwork)])].filter((n) => !autoCovers(n))
    : [];
  const autoWorker =
    autoOn || custodianNetworks.length > 0
      ? startAutoDiscoveryWorker(async (analyzed) => {
          await broadcastMigrationAlert(bot, analyzed);
        })
      : null;
  if (autoDiscoveryMode() === "paused-no-okx") {
    logger.warn(
      "Auto-discovery paused: OKX_API_KEY/OKX_SECRET_KEY/OKX_API_PASSPHRASE are not set, so no auto alert could pass the liquidity filter — not spending RPC on it",
    );
  }

  // Documented tokenized-stock deployers (Robinhood, Dinari) on first start,
  // then CUSTODIAN_DEPLOYERS; more can be added with /add_custodian.
  await custodianRepository.seedBuiltinsOnce();
  for (const c of parseCustodianSeed(process.env.CUSTODIAN_DEPLOYERS)) {
    await custodianRepository.upsert(c.network, c.address, c.label);
  }

  for (const error of networkConfigErrors) {
    logger.error({ error }, "Skipping misconfigured custom network (EXTRA_NETWORKS)");
  }
  const unknown = unknownEnabledNetworks();
  if (unknown.length > 0) {
    logger.warn({ unknown }, "ENABLED_NETWORKS lists networks that don't exist — typo?");
  }

  const unknownCustodianNetworks = env.custodianNetworks().filter((k) => !isKnownNetwork(k));
  if (unknownCustodianNetworks.length > 0) {
    logger.warn({ unknown: unknownCustodianNetworks }, "CUSTODIAN_NETWORKS lists networks that don't exist — typo?");
  }

  const enqueueAuto =
    (network: string): UntrackedCreationHandler =>
    async (event) => {
      await enqueueAutoCandidate(event).catch((err) => {
        logger.error({ err, network, contractAddress: event.contractAddress }, "Failed to enqueue auto-discovery job");
      });
    };

  // One network failing to start (bad RPC URL, etc.) must not stop the others.
  const started: string[] = [];
  const stopListeners: Array<() => Promise<void>> = [];
  for (const network of enabledNetworks()) {
    try {
      stopListeners.push(
        startBlockListener(
          network,
          async (event) => {
            await enqueueContractCreation(event).catch((err) => {
              logger.error({ err, network, contractAddress: event.contractAddress }, "Failed to enqueue analysis job");
            });
          },
          autoCovers(network) ? enqueueAuto(network) : undefined,
        ),
      );
      started.push(network);
    } catch (err) {
      logger.error({ err, network }, "Failed to start block listener for network");
    }
  }
  for (const network of custodianNetworks) {
    try {
      stopListeners.push(startCustodianWatcher(network, enqueueAuto(network)));
    } catch (err) {
      logger.error({ err, network }, "Failed to start custodian watch for network");
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
    await Promise.all([worker.close(), autoWorker?.close(), ownerRefreshWorker?.close()]);
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // launch() only resolves once polling stops, so anything after it would
  // never run while the bot is up — hence the onLaunch callback and the
  // signal handlers being registered first.
  await launchWithConflictRetry(bot, () => {
    logger.info({ networks: started, custodianWatch: custodianNetworks }, "Multi-EVM migration tracker started");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
