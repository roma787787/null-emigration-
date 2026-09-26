import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

// tsc only emits compiled .ts files — non-TS runtime assets (the schema.sql
// migrate.ts reads at boot) need to be copied into dist/ separately.
const assets = [["src/db/schema.sql", "dist/db/schema.sql"]];

for (const [from, to] of assets) {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}
