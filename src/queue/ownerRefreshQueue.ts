import { Queue, Worker } from "bullmq";
import { createRedisConnection } from "./redisClient.js";
import { refreshAllOwners, type OwnersRefreshed } from "../chain/ownerRefresh.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const QUEUE_NAME = "owner-refresh";
const SCHEDULER_ID = "refresh-owners";

/**
 * Re-discovers every tracked token's owners every OWNER_REFRESH_INTERVAL_HOURS.
 * The schedule lives in Redis (a BullMQ job scheduler), so a redeploy doesn't
 * reset it or trigger an extra run.
 */
export async function startOwnerRefresh(onAdded: (result: OwnersRefreshed) => Promise<void>): Promise<Worker | null> {
  const queue = new Queue(QUEUE_NAME, { connection: createRedisConnection() });
  if (!(env.OWNER_REFRESH_INTERVAL_HOURS > 0)) {
    await queue.removeJobScheduler(SCHEDULER_ID);
    await queue.close();
    logger.info("Periodic owner refresh disabled (OWNER_REFRESH_INTERVAL_HOURS=0)");
    return null;
  }

  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { every: env.OWNER_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000 },
    { name: SCHEDULER_ID, opts: { removeOnComplete: 10, removeOnFail: 10 } },
  );
  await queue.close();

  const worker = new Worker(QUEUE_NAME, async () => refreshAllOwners(onAdded), {
    connection: createRedisConnection(),
    concurrency: 1,
    // A full pass over many tokens can take minutes.
    lockDuration: 10 * 60 * 1000,
  });
  worker.on("failed", (_job, err) => logger.error({ err }, "Owner refresh run failed"));
  return worker;
}
