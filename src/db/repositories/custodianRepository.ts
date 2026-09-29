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
 * Publicly documented tokenized-stock deployers, seeded once per `since`
 * batch: a batch added in a later release reaches existing installs, while
 * entries an admin removed earlier stay removed.
 */
export const BUILTIN_CUSTODIANS: Array<CustodianRecord & { since: number }> = [
  // Arbiscan label "Robinhood: Deployer" — deploys Robinhood's stock tokens on Arbitrum.
  { since: 1, network: "arbitrum", address: "0xcbdf630a858e7d87b5b08d92968ca14ca0f8f556", label: "Robinhood Onchain" },
  // Dinari DShareFactory, production — github.com/dinaricrypto/sbt-contracts releases/v0.4.0/dshare_factory.json
  { since: 1, network: "ethereum", address: "0x60b5e7eecb2aee0382db86491b8cffa39347c747", label: "Dinari dShares" },
  { since: 1, network: "arbitrum", address: "0xb4ca72ea4d072c779254269fd56093d3adf603b8", label: "Dinari dShares" },
  { since: 1, network: "base", address: "0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d", label: "Dinari dShares" },
  { since: 1, network: "blast", address: "0x6aa1bda7e764bc62589e64f371a4022b80b3c72a", label: "Dinari dShares" },
  // StockFactory on Robinhood Chain — creator of every Robinhood Stock Token there (emits Deployed(uid, stock, name, symbol)).
  { since: 2, network: "robinhood", address: "0x4783c67b63de2b358ac5951a7d41f47a38f3c046", label: "Robinhood Stock Tokens" },
  // Etherscan label "Backed: Deployer" — Backed Finance bTokens / xStocks on Ethereum.
  { since: 2, network: "ethereum", address: "0x5f7a4c11bde4f218f0025ef444c369d838ffa2ad", label: "Backed Finance" },
];
const SEED_MARKER = (batch: number) => `custodians_seeded_v${batch}`;
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
  /** Adds each batch of BUILTIN_CUSTODIANS once; afterwards the registry is the admins'. */
  async seedBuiltinsOnce(): Promise<number> {
    let added = 0;
    for (const batch of [...new Set(BUILTIN_CUSTODIANS.map((c) => c.since))]) {
      const { rowCount } = await pool.query(
        `INSERT INTO app_meta (key, value) VALUES ($1, 'done') ON CONFLICT (key) DO NOTHING`,
        [SEED_MARKER(batch)],
      );
      if ((rowCount ?? 0) === 0) continue;
      for (const c of BUILTIN_CUSTODIANS.filter((c) => c.since === batch)) {
        await pool.query(
          `INSERT INTO custodians (network, address, label) VALUES ($1, lower($2), $3) ON CONFLICT (network, address) DO NOTHING`,
          [c.network, c.address, c.label],
        );
        added++;
      }
    }
    cache = null;
    return added;
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

  /** Registered custodian addresses on `network`. */
  async addressesOn(network: NetworkKey): Promise<`0x${string}`[]> {
    const prefix = `${network}:`;
    return [...(await labelMap()).keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length) as `0x${string}`);
  },

  /** Label of the custodian that deployed from `address` on `network`, if any (cached briefly — checked for every block). */
  async labelFor(network: NetworkKey, address: string): Promise<string | null> {
    return (await labelMap()).get(`${network}:${address.toLowerCase()}`) ?? null;
  },
};

function labelMap(): Promise<Map<string, string>> {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const map = custodianRepository.listAll().then((rows) => new Map(rows.map((r) => [`${r.network}:${r.address}`, r.label])));
    cache = { at: Date.now(), map };
    map.catch(() => (cache = null));
  }
  return cache.map;
}
