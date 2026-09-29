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
