import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./client.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf8");
  await pool.query(schema);
  logger.info("Database schema is up to date");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, "Migration failed");
      process.exitCode = 1;
    });
}
