import { pool } from "../client.js";
import type { NetworkKey, TokenRecord } from "../../types/index.js";

interface TokenRow {
  id: number;
  network: string;
  address: string;
  symbol: string | null;
  name: string | null;
  added_by_chat_id: string;
  created_at: Date;
}

function toTokenRecord(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    network: row.network as NetworkKey,
    address: row.address as `0x${string}`,
    symbol: row.symbol,
    name: row.name,
    addedByChatId: row.added_by_chat_id,
    createdAt: row.created_at,
  };
}

export const tokenRepository = {
  async add(
    network: NetworkKey,
    address: `0x${string}`,
    addedByChatId: string,
    meta: { symbol: string | null; name: string | null },
  ): Promise<TokenRecord> {
    const { rows } = await pool.query<TokenRow>(
      `INSERT INTO tokens (network, address, symbol, name, added_by_chat_id)
       VALUES ($1, lower($2), $3, $4, $5)
       ON CONFLICT (network, address) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name
       RETURNING *`,
      [network, address, meta.symbol, meta.name, addedByChatId],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert token");
    return toTokenRecord(row);
  },

  async remove(network: NetworkKey, address: `0x${string}`): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM tokens WHERE network = $1 AND address = lower($2)`, [
      network,
      address,
    ]);
    return (rowCount ?? 0) > 0;
  },

  async removeByAddress(address: `0x${string}`): Promise<number> {
    const { rowCount } = await pool.query(`DELETE FROM tokens WHERE address = lower($1)`, [address]);
    return rowCount ?? 0;
  },

  async findByNetworkAndAddress(network: NetworkKey, address: `0x${string}`): Promise<TokenRecord | null> {
    const { rows } = await pool.query<TokenRow>(`SELECT * FROM tokens WHERE network = $1 AND address = lower($2)`, [
      network,
      address,
    ]);
    return rows[0] ? toTokenRecord(rows[0]) : null;
  },

  async findById(id: number): Promise<TokenRecord | null> {
    const { rows } = await pool.query<TokenRow>(`SELECT * FROM tokens WHERE id = $1`, [id]);
    return rows[0] ? toTokenRecord(rows[0]) : null;
  },

  async listAll(): Promise<TokenRecord[]> {
    const { rows } = await pool.query<TokenRow>(`SELECT * FROM tokens ORDER BY created_at DESC`);
    return rows.map(toTokenRecord);
  },

  async listByAddedByChatId(chatId: string): Promise<TokenRecord[]> {
    const { rows } = await pool.query<TokenRow>(
      `SELECT * FROM tokens WHERE added_by_chat_id = $1 ORDER BY created_at DESC`,
      [chatId],
    );
    return rows.map(toTokenRecord);
  },
};
