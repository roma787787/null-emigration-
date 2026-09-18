import { pool } from "../client.js";
import type { ConfidenceLevel, MigrationContractRecord, NetworkKey } from "../../types/index.js";

interface MigrationContractRow {
  id: number;
  token_id: number;
  network: string;
  contract_address: string;
  creator_address: string;
  token_b_address: string | null;
  confidence: string;
  matched_functions: string[];
  tx_hash: string;
  block_number: string;
  detected_at: Date;
}

function toRecord(row: MigrationContractRow): MigrationContractRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    network: row.network as NetworkKey,
    contractAddress: row.contract_address as `0x${string}`,
    creatorAddress: row.creator_address as `0x${string}`,
    tokenBAddress: row.token_b_address as `0x${string}` | null,
    confidence: row.confidence as ConfidenceLevel,
    matchedFunctions: row.matched_functions,
    txHash: row.tx_hash as `0x${string}`,
    blockNumber: BigInt(row.block_number),
    detectedAt: row.detected_at,
  };
}

export const migrationContractRepository = {
  async create(input: {
    tokenId: number;
    network: NetworkKey;
    contractAddress: `0x${string}`;
    creatorAddress: `0x${string}`;
    tokenBAddress: `0x${string}` | null;
    confidence: ConfidenceLevel;
    matchedFunctions: string[];
    txHash: `0x${string}`;
    blockNumber: bigint;
  }): Promise<MigrationContractRecord | null> {
    const { rows } = await pool.query<MigrationContractRow>(
      `INSERT INTO migration_contracts
         (token_id, network, contract_address, creator_address, token_b_address, confidence, matched_functions, tx_hash, block_number)
       VALUES ($1, $2, lower($3), lower($4), lower($5), $6, $7, $8, $9)
       ON CONFLICT (network, contract_address) DO NOTHING
       RETURNING *`,
      [
        input.tokenId,
        input.network,
        input.contractAddress,
        input.creatorAddress,
        input.tokenBAddress,
        input.confidence,
        input.matchedFunctions,
        input.txHash,
        input.blockNumber.toString(),
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async alreadySeen(network: NetworkKey, contractAddress: `0x${string}`): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM migration_contracts WHERE network = $1 AND contract_address = lower($2)`,
      [network, contractAddress],
    );
    return rows.length > 0;
  },

  async listForToken(tokenId: number): Promise<MigrationContractRecord[]> {
    const { rows } = await pool.query<MigrationContractRow>(
      `SELECT * FROM migration_contracts WHERE token_id = $1 ORDER BY detected_at DESC`,
      [tokenId],
    );
    return rows.map(toRecord);
  },
};
