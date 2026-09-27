import { pool } from "../client.js";

export const statsRepository = {
  async counts(): Promise<{ tokens: number; owners: number; contracts: number }> {
    const { rows } = await pool.query<{ tokens: string; owners: string; contracts: string }>(
      `SELECT (SELECT count(*) FROM tokens) AS tokens,
              (SELECT count(DISTINCT lower(address)) FROM token_owners) AS owners,
              (SELECT count(*) FROM migration_contracts) AS contracts`,
    );
    const row = rows[0]!;
    return { tokens: Number(row.tokens), owners: Number(row.owners), contracts: Number(row.contracts) };
  },
};
