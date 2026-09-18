import { pool } from "../client.js";
import type { ChatSettingsRecord, ConfidenceFilter, NetworkKey } from "../../types/index.js";

interface ChatSettingsRow {
  chat_id: string;
  confidence_filter: string;
  networks_filter: string[] | null;
  created_at: Date;
}

function toRecord(row: ChatSettingsRow): ChatSettingsRecord {
  return {
    chatId: row.chat_id,
    confidenceFilter: row.confidence_filter as ConfidenceFilter,
    networksFilter: (row.networks_filter as NetworkKey[] | null) ?? null,
    createdAt: row.created_at,
  };
}

export const chatSettingsRepository = {
  async ensure(chatId: string): Promise<ChatSettingsRecord> {
    const { rows } = await pool.query<ChatSettingsRow>(
      `INSERT INTO chat_settings (chat_id) VALUES ($1)
       ON CONFLICT (chat_id) DO UPDATE SET chat_id = EXCLUDED.chat_id
       RETURNING *`,
      [chatId],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert chat settings");
    return toRecord(row);
  },

  async get(chatId: string): Promise<ChatSettingsRecord | null> {
    const { rows } = await pool.query<ChatSettingsRow>(`SELECT * FROM chat_settings WHERE chat_id = $1`, [chatId]);
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async setConfidenceFilter(chatId: string, filter: ConfidenceFilter): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, confidence_filter) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET confidence_filter = EXCLUDED.confidence_filter`,
      [chatId, filter],
    );
  },

  async setNetworksFilter(chatId: string, networks: NetworkKey[] | null): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, networks_filter) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET networks_filter = EXCLUDED.networks_filter`,
      [chatId, networks],
    );
  },

  async listAll(): Promise<ChatSettingsRecord[]> {
    const { rows } = await pool.query<ChatSettingsRow>(`SELECT * FROM chat_settings`);
    return rows.map(toRecord);
  },
};
