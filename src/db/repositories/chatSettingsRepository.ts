import { pool } from "../client.js";
import type { ChatSettingsRecord, ConfidenceFilter, Language, LiquidityLevel, NetworkKey } from "../../types/index.js";

interface ChatSettingsRow {
  chat_id: string;
  confidence_filter: string;
  networks_filter: string[] | null;
  language: string | null;
  approved: boolean;
  access_requested: boolean;
  liquidity_level: string;
  auto_alerts: boolean;
  created_at: Date;
}

function toRecord(row: ChatSettingsRow): ChatSettingsRecord {
  return {
    chatId: row.chat_id,
    liquidityLevel: row.liquidity_level === "LOW_CAP" || row.liquidity_level === "DEEP" ? row.liquidity_level : "STRICT",
    autoAlerts: row.auto_alerts,
    confidenceFilter: row.confidence_filter as ConfidenceFilter,
    networksFilter: (row.networks_filter as NetworkKey[] | null) ?? null,
    language: row.language as Language | null,
    approved: row.approved,
    accessRequested: row.access_requested,
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

  async setLiquidityLevel(chatId: string, level: LiquidityLevel): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, liquidity_level) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET liquidity_level = EXCLUDED.liquidity_level`,
      [chatId, level],
    );
  },

  async setAutoAlerts(chatId: string, enabled: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, auto_alerts) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET auto_alerts = EXCLUDED.auto_alerts`,
      [chatId, enabled],
    );
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

  async setLanguage(chatId: string, language: Language): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, language) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET language = EXCLUDED.language`,
      [chatId, language],
    );
  },

  async setApproved(chatId: string, approved: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, approved) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET approved = EXCLUDED.approved`,
      [chatId, approved],
    );
  },

  async setAccessRequested(chatId: string, accessRequested: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO chat_settings (chat_id, access_requested) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET access_requested = EXCLUDED.access_requested`,
      [chatId, accessRequested],
    );
  },

  async listAll(): Promise<ChatSettingsRecord[]> {
    const { rows } = await pool.query<ChatSettingsRow>(`SELECT * FROM chat_settings`);
    return rows.map(toRecord);
  },
};
