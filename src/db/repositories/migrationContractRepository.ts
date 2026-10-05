import { pool } from "../client.js";
import type {
  ConfidenceLevel,
  DiscoveryKind,
  MigrationAnalysisResult,
  MigrationContractRecord,
  NetworkKey,
  TokenBSource,
} from "../../types/index.js";

interface MigrationContractRow {
  id: number;
  token_id: number | null;
  discovery: string;
  token_a_address: string | null;
  token_a_symbol: string | null;
  token_b_symbol_unverified: string | null;
  rwa_signals: string[];
  liquidity: MigrationContractRecord["liquidity"];
  custodian_label: string | null;
  network: string;
  contract_address: string;
  creator_address: string;
  token_b_address: string | null;
  confidence: string;
  confidence_score: number;
  matched_functions: string[];
  matched_events: string[];
  matched_auxiliary: string[];
  token_b_source: string | null;
  matched_getter: string | null;
  tx_hash: string;
  block_number: string;
  detected_at: Date;
  terms: MigrationContractRecord["terms"];
  opened_at: Date | null;
  opened_tx: string | null;
  open_cursor: string | null;
}

function toRecord(row: MigrationContractRow): MigrationContractRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    discovery: row.discovery as DiscoveryKind,
    tokenAAddress: row.token_a_address as `0x${string}` | null,
    tokenASymbol: row.token_a_symbol,
    tokenBSymbolUnverified: row.token_b_symbol_unverified,
    rwaSignals: row.rwa_signals ?? [],
    liquidity: row.liquidity ?? null,
    custodianLabel: row.custodian_label,
    network: row.network as NetworkKey,
    contractAddress: row.contract_address as `0x${string}`,
    creatorAddress: row.creator_address as `0x${string}`,
    tokenBAddress: row.token_b_address as `0x${string}` | null,
    confidence: row.confidence as ConfidenceLevel,
    confidenceScore: row.confidence_score,
    matchedFunctions: row.matched_functions,
    matchedEvents: row.matched_events,
    matchedAuxiliary: row.matched_auxiliary,
    tokenBSource: row.token_b_source as TokenBSource | null,
    matchedGetter: row.matched_getter,
    txHash: row.tx_hash as `0x${string}`,
    blockNumber: BigInt(row.block_number),
    detectedAt: row.detected_at,
    terms: row.terms ?? null,
    openedAt: row.opened_at ?? null,
    openedTx: (row.opened_tx as `0x${string}` | null) ?? null,
  };
}

export const migrationContractRepository = {
  async create(input: {
    tokenId: number | null;
    discovery?: DiscoveryKind;
    tokenAAddress?: `0x${string}` | null;
    tokenASymbol?: string | null;
    tokenBSymbolUnverified?: string | null;
    rwaSignals?: string[];
    liquidity?: MigrationContractRecord["liquidity"];
    custodianLabel?: string | null;
    network: NetworkKey;
    contractAddress: `0x${string}`;
    creatorAddress: `0x${string}`;
    tokenBAddress: `0x${string}` | null;
    confidence: ConfidenceLevel;
    confidenceScore: number;
    matchedFunctions: string[];
    matchedEvents: string[];
    matchedAuxiliary: string[];
    tokenBSource: TokenBSource | null;
    matchedGetter: string | null;
    txHash: `0x${string}`;
    blockNumber: bigint;
    terms?: MigrationContractRecord["terms"];
  }): Promise<MigrationContractRecord | null> {
    const { rows } = await pool.query<MigrationContractRow>(
      `INSERT INTO migration_contracts
         (token_id, network, contract_address, creator_address, token_b_address, confidence, confidence_score,
          matched_functions, matched_events, matched_auxiliary, token_b_source, matched_getter, tx_hash, block_number,
          discovery, token_a_address, token_a_symbol, token_b_symbol_unverified, rwa_signals, liquidity, custodian_label,
          terms)
       VALUES ($1, $2, lower($3), lower($4), lower($5), $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, lower($16), $17, $18, $19, $20, $21, $22)
       ON CONFLICT (network, contract_address) DO NOTHING
       RETURNING *`,
      [
        input.tokenId,
        input.network,
        input.contractAddress,
        input.creatorAddress,
        input.tokenBAddress,
        input.confidence,
        input.confidenceScore,
        input.matchedFunctions,
        input.matchedEvents,
        input.matchedAuxiliary,
        input.tokenBSource,
        input.matchedGetter,
        input.txHash,
        input.blockNumber.toString(),
        input.discovery ?? "tracked",
        input.tokenAAddress ?? null,
        input.tokenASymbol ?? null,
        input.tokenBSymbolUnverified ?? null,
        input.rwaSignals ?? [],
        input.liquidity ? JSON.stringify(input.liquidity) : null,
        input.custodianLabel ?? null,
        input.terms ? JSON.stringify(input.terms) : null,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async setTerms(id: number, terms: MigrationContractRecord["terms"]): Promise<void> {
    await pool.query(`UPDATE migration_contracts SET terms = $2 WHERE id = $1`, [id, terms ? JSON.stringify(terms) : null]);
  },

  /**
   * Alerted contracts not yet seen open, detected within `days` and with a
   * Token A: what the opening watcher scans. Only detections that carry terms
   * (alerted since the watch exists, through the current filters) — never a
   * backlog of old ones. `cursor` is the last block scanned, null before the first pass.
   */
  async listAwaitingOpen(network: NetworkKey, days: number): Promise<(MigrationContractRecord & { cursor: bigint | null })[]> {
    const { rows } = await pool.query<MigrationContractRow>(
      `SELECT * FROM migration_contracts
        WHERE network = $1 AND opened_at IS NULL AND token_a_address IS NOT NULL AND terms IS NOT NULL
          AND detected_at > now() - make_interval(days => $2)
        ORDER BY detected_at`,
      [network, days],
    );
    return rows.map((row) => ({ ...toRecord(row), cursor: row.open_cursor === null ? null : BigInt(row.open_cursor) }));
  },

  async setOpenCursor(id: number, block: bigint): Promise<void> {
    await pool.query(`UPDATE migration_contracts SET open_cursor = $2 WHERE id = $1`, [id, block.toString()]);
  },

  /** Marks the contract opened; false when another worker already did. */
  async markOpened(id: number, txHash: `0x${string}`, block: bigint, terms: MigrationContractRecord["terms"]): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE migration_contracts SET opened_at = now(), opened_tx = lower($2), open_cursor = $3, terms = COALESCE($4, terms)
        WHERE id = $1 AND opened_at IS NULL`,
      [id, txHash, block.toString(), terms ? JSON.stringify(terms) : null],
    );
    return (rowCount ?? 0) > 0;
  },

  async alreadySeen(network: NetworkKey, contractAddress: `0x${string}`): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM migration_contracts WHERE network = $1 AND contract_address = lower($2)`,
      [network, contractAddress],
    );
    return rows.length > 0;
  },

  async findByContract(network: NetworkKey, contractAddress: `0x${string}`): Promise<MigrationContractRecord | null> {
    const { rows } = await pool.query<MigrationContractRow>(
      `SELECT * FROM migration_contracts WHERE network = $1 AND contract_address = lower($2)`,
      [network, contractAddress],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  },

  /** Stores a re-analysis of an already-detected contract. */
  async updateAnalysis(
    id: number,
    analysis: Pick<
      MigrationAnalysisResult,
      | "tokenBAddress"
      | "confidence"
      | "confidenceScore"
      | "matchedFunctions"
      | "matchedEvents"
      | "matchedAuxiliary"
      | "tokenBSource"
      | "matchedGetter"
      | "tokenBSymbolUnverified"
      | "rwaSignals"
    >,
  ): Promise<MigrationContractRecord | null> {
    const { rows } = await pool.query<MigrationContractRow>(
      `UPDATE migration_contracts
          SET token_b_address = lower($2), confidence = $3, confidence_score = $4, matched_functions = $5,
              matched_events = $6, matched_auxiliary = $7, token_b_source = $8, matched_getter = $9,
              token_b_symbol_unverified = $10, rwa_signals = $11
        WHERE id = $1
        RETURNING *`,
      [
        id,
        analysis.tokenBAddress,
        analysis.confidence,
        analysis.confidenceScore,
        analysis.matchedFunctions,
        analysis.matchedEvents,
        analysis.matchedAuxiliary,
        analysis.tokenBSource,
        analysis.matchedGetter,
        analysis.tokenBSymbolUnverified,
        analysis.rwaSignals,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async listForToken(tokenId: number): Promise<MigrationContractRecord[]> {
    const { rows } = await pool.query<MigrationContractRow>(
      `SELECT * FROM migration_contracts WHERE token_id = $1 ORDER BY detected_at DESC`,
      [tokenId],
    );
    return rows.map(toRecord);
  },
};
