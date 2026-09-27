import { pool } from "../client.js";
import type { NetworkKey } from "../../types/index.js";
import { parseList } from "../../config/env.js";

export interface CustodianRecord {
  network: NetworkKey;
  address: `0x${string}`;
  label: string;
}

const CACHE_TTL_MS = 30_000;

/**
 * Publicly documented tokenized-stock deployers, seeded once on first start.
 * Backed Finance (xStocks) isn't listed: its factory address couldn't be
 * confirmed from a public source — add it with /add_custodian.
 */
export const BUILTIN_CUSTODIANS: CustodianRecord[] = [
  // Arbiscan label "Robinhood: Deployer" — deploys Robinhood's stock tokens on Arbitrum.
  { network: "arbitrum", address: "0xcbdf630a858e7d87b5b08d92968ca14ca0f8f556", label: "Robinhood Onchain" },
  // Dinari DShareFactory, production — github.com/dinaricrypto/sbt-contracts releases/v0.4.0/dshare_factory.json
  { network: "ethereum", address: "0x60b5e7eecb2aee0382db86491b8cffa39347c747", label: "Dinari dShares" },
  { network: "arbitrum", address: "0xb4ca72ea4d072c779254269fd56093d3adf603b8", label: "Dinari dShares" },
  { network: "base", address: "0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d", label: "Dinari dShares" },
  { network: "blast", address: "0x6aa1bda7e764bc62589e64f371a4022b80b3c72a", label: "Dinari dShares" },
];
const SEED_MARKER = "custodians_seeded_v1";
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
  /** Adds BUILTIN_CUSTODIANS the first time the bot starts; afterwards the registry is the admins'. */
  async seedBuiltinsOnce(): Promise<number> {
    const { rowCount } = await pool.query(
      `INSERT INTO app_meta (key, value) VALUES ($1, 'done') ON CONFLICT (key) DO NOTHING`,
      [SEED_MARKER],
    );
    if ((rowCount ?? 0) === 0) return 0;
    for (const c of BUILTIN_CUSTODIANS) {
      await pool.query(
        `INSERT INTO custodians (network, address, label) VALUES ($1, lower($2), $3) ON CONFLICT (network, address) DO NOTHING`,
        [c.network, c.address, c.label],
      );
    }
    cache = null;
    return BUILTIN_CUSTODIANS.length;
  },

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
