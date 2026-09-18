import { Redis } from "ioredis";
import { env } from "../config/env.js";

// BullMQ requires maxRetriesPerRequest disabled on the connection it manages.
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
