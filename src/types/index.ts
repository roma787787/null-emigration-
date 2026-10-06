/**
 * A network's registry key — one of the built-ins in src/config/networks.ts
 * or a custom one declared via EXTRA_NETWORKS, so it's validated at runtime
 * (isKnownNetwork) rather than as a closed string union.
 */
export type NetworkKey = string;

export type OwnerSource = "deployer" | "owner" | "admin" | "default_admin_role" | "manual";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export type ConfidenceFilter = "ALL" | "HIGH_ONLY";

export type Language = "en" | "uk" | "ru";

export interface TokenRecord {
  id: number;
  network: NetworkKey;
  address: `0x${string}`;
  symbol: string | null;
  name: string | null;
  addedByChatId: string;
  createdAt: Date;
}

export interface TokenOwnerRecord {
  id: number;
  tokenId: number;
  address: `0x${string}`;
  source: OwnerSource;
  createdAt: Date;
}

/** How a detection was found: a tracked project's wallet, a scan of all new contracts, or a registered RWA custodian. */
export type DiscoveryKind = "tracked" | "auto" | "custodian";

export type LiquidityLevel = "LOW_CAP" | "STRICT" | "DEEP";

export interface StoredLiquidityCheck {
  status: "pass" | "skip" | "unchecked";
  level: LiquidityLevel;
  amountUsd: number;
  maxImpactPercent: number;
  impactPercent: number | null;
  reason: string;
}

/** What a trader needs to act on a migration, read from the contract (see analyzer/migrationTerms.ts). */
export interface MigrationTerms {
  /** open: exchanges can happen now; not_started: before its start time or not yet enabled. */
  status: "open" | "paused" | "not_started" | "ended" | "unknown";
  /** Unix seconds, when the contract holds them. */
  startsAt: number | null;
  endsAt: number | null;
  /** A ratio/rate getter's raw value — its meaning (old per new, scaled…) varies by contract. */
  ratio: { getter: string; value: string } | null;
  /** New tokens already on the contract to hand out, or minted on exchange (the contract is the new token). */
  funding: { kind: "balance"; amount: string; empty: boolean; symbol: string | null } | { kind: "mint" } | null;
  /** USD per whole token from $300 test swaps, and buy-old/migrate/sell-new at 1:1 in percent. */
  prices: {
    oldUsd: number | null;
    newUsd: number | null;
    spreadPercent: number | null;
    at: number;
    /** The price came from a small quote that moved the market a lot (a thin pool): indicative only. */
    oldThin?: boolean;
    newThin?: boolean;
    /**
     * The trade itself, both sides quoted: $inUsd buys old tokens, migrated
     * 1:1, sold back for $outUsd (null: no route to sell the new token).
     */
    roundTrip?: { inUsd: number; outUsd: number | null; percent: number | null };
  } | null;
}

export interface MigrationContractRecord {
  id: number;
  /** The tracked token it belongs to; null for auto-discovered contracts. */
  tokenId: number | null;
  discovery: DiscoveryKind;
  /** Token A as read from the contract (auto) or the tracked token's address. */
  tokenAAddress: `0x${string}` | null;
  tokenASymbol: string | null;
  tokenBSymbolUnverified: string | null;
  rwaSignals: string[];
  /** OKX test swaps into Token A, per level; null when not checked (tracked projects, custodians). */
  liquidity: Record<LiquidityLevel, StoredLiquidityCheck> | null;
  custodianLabel: string | null;
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
  detectedAt: Date;
  /** Read at detection; null for detections stored before terms existed or when nothing could be read. */
  terms?: MigrationTerms | null;
  /** When the first exchange through the contract was seen (the "migration opened" alert), and its transaction. */
  openedAt?: Date | null;
  openedTx?: `0x${string}` | null;
}

export interface ChatSettingsRecord {
  chatId: string;
  liquidityLevel: LiquidityLevel;
  /** Receive auto-discovered alerts (not only tracked projects'). */
  autoAlerts: boolean;
  /** Receive a card for every new token an RWA custodian launches (e.g. a new Robinhood stock token). */
  rwaListings: boolean;
  confidenceFilter: ConfidenceFilter;
  networksFilter: NetworkKey[] | null;
  /** null = the chat hasn't picked a language yet (shows the picker). */
  language: Language | null;
  approved: boolean;
  accessRequested: boolean;
  createdAt: Date;
}

export type TokenBSource = "constructor_args" | "static_call" | "token_a_match" | "contract_itself" | "bytecode";

export interface MigrationAnalysisResult {
  /** Which of the candidate Token A addresses the contract was attributed to (null if none given). */
  tokenAAddress: `0x${string}` | null;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  tokenBAddress: `0x${string}` | null;
  tokenBSource: TokenBSource | null;
  matchedGetter: string | null;
  matchedFunctions: string[];
  matchedEvents: string[];
  matchedAuxiliary: string[];
  /** Token B given only as a ticker, with no address: shown as Unverified, confidence LOW. */
  tokenBSymbolUnverified: string | null;
  /** Tokenized-stock / RWA getters present (isin(), cusip(), underlyingAsset(), issuer()). */
  rwaSignals: string[];
}

export interface ContractCreationEvent {
  network: NetworkKey;
  contractAddress: `0x${string}`;
  creatorAddress: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: bigint;
  input: `0x${string}`;
}
