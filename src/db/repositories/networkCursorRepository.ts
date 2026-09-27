import { pool } from "../client.js";
import type { NetworkKey } from "../../types/index.js";

export const networkCursorRepository = {
  async get(network: NetworkKey): Promise<bigint | null> {
    const { rows } = await pool.query<{ last_block: string }>(
      `SELECT last_block FROM network_cursors WHERE network = $1`,
      [network],
    );
    return rows[0] ? BigInt(rows[0].last_block) : null;
  },

  async save(network: NetworkKey, lastBlock: bigint): Promise<void> {
    await pool.query(
      `INSERT INTO network_cursors (network, last_block, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (network) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
      [network, lastBlock.toString()],
    );
  },
};
