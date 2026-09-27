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

export interface MigrationContractRecord {
  id: number;
  tokenId: number;
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
  confidenceFilter: ConfidenceFilter;
  networksFilter: NetworkKey[] | null;
  /** null = the chat hasn't picked a language yet (shows the picker). */
  language: Language | null;
  approved: boolean;
  accessRequested: boolean;
  createdAt: Date;
}

export type TokenBSource = "constructor_args" | "static_call" | "token_a_match";

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
}

export interface ContractCreationEvent {
  network: NetworkKey;
  contractAddress: `0x${string}`;
  creatorAddress: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: bigint;
  input: `0x${string}`;
}
