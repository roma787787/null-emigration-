import { pool } from "../client.js";
import type { NetworkKey } from "../../types/index.js";
import { parseList } from "../../config/env.js";

export interface CustodianRecord {
  network: NetworkKey;
  address: `0x${string}`;
  label: string;
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; map: Promise<Map<string, string>> } | null = null;

/** CUSTODIAN_DEPLOYERS="network:0xaddress:Label,..." — seeds the registry at startup. */
export function parseCustodianSeed(value: string | undefined): CustodianRecord[] {
  return parseList(value).flatMap((entry) => {
    const [network, address, ...label] = entry.split(":");
    if (!network || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
    return [{ network: network.toLowerCase(), address: address.toLowerCase() as `0x${string}`, label: label.join(":") || "custodian" }];
  });
}

export const custodianRepository = {
  async upsert(network: NetworkKey, address: string, label: string): Promise<void> {
    await pool.query(
      `INSERT INTO custodians (network, address, label) VALUES ($1, lower($2), $3)
       ON CONFLICT (network, address) DO UPDATE SET label = EXCLUDED.label`,
      [network, address, label],
    );
    cache = null;
  },

  async remove(network: NetworkKey, address: string): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM custodians WHERE network = $1 AND address = lower($2)`, [
      network,
      address,
    ]);
    cache = null;
    return (rowCount ?? 0) > 0;
  },

  async listAll(): Promise<CustodianRecord[]> {
    const { rows } = await pool.query<CustodianRecord>(`SELECT network, address, label FROM custodians ORDER BY network, label`);
    return rows;
  },

  /** Label of the custodian that deployed from `address` on `network`, if any (cached briefly — checked for every block). */
  async labelFor(network: NetworkKey, address: string): Promise<string | null> {
    if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
      const map = this.listAll().then((rows) => new Map(rows.map((r) => [`${r.network}:${r.address}`, r.label])));
      cache = { at: Date.now(), map };
      map.catch(() => (cache = null));
    }
    return (await cache.map).get(`${network}:${address.toLowerCase()}`) ?? null;
  },
};
