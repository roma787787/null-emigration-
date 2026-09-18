import { pool } from "../client.js";
import type { OwnerSource, TokenOwnerRecord } from "../../types/index.js";

interface OwnerRow {
  id: number;
  token_id: number;
  address: string;
  source: string;
  created_at: Date;
}

function toOwnerRecord(row: OwnerRow): TokenOwnerRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    address: row.address as `0x${string}`,
    source: row.source as OwnerSource,
    createdAt: row.created_at,
  };
}

export const ownerRepository = {
  async upsert(tokenId: number, address: `0x${string}`, source: OwnerSource): Promise<TokenOwnerRecord> {
    const { rows } = await pool.query<OwnerRow>(
      `INSERT INTO token_owners (token_id, address, source)
       VALUES ($1, lower($2), $3)
       ON CONFLICT (token_id, address) DO UPDATE SET source = EXCLUDED.source
       RETURNING *`,
      [tokenId, address, source],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert token owner");
    return toOwnerRecord(row);
  },

  async listForToken(tokenId: number): Promise<TokenOwnerRecord[]> {
    const { rows } = await pool.query<OwnerRow>(`SELECT * FROM token_owners WHERE token_id = $1 ORDER BY id`, [
      tokenId,
    ]);
    return rows.map(toOwnerRecord);
  },

  /**
   * Looks up which token a given address is a known owner/deployer/admin of.
   * Used by the block listener to decide whether a contract-creation tx
   * originated from a tracked project.
   */
  async findTokenIdsByOwnerAddress(address: `0x${string}`): Promise<number[]> {
    const { rows } = await pool.query<{ token_id: number }>(
      `SELECT DISTINCT token_id FROM token_owners WHERE address = lower($1)`,
      [address],
    );
    return rows.map((r) => r.token_id);
  },

  async remove(tokenId: number, address: `0x${string}`): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM token_owners WHERE token_id = $1 AND address = lower($2)`, [
      tokenId,
      address,
    ]);
    return (rowCount ?? 0) > 0;
  },
};
