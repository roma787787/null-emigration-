export type NetworkKey =
  | "ethereum"
  | "bsc"
  | "arbitrum"
  | "base"
  | "optimism"
  | "polygon"
  | "avalanche"
  | "linea"
  | "scroll"
  | "blast"
  | "polygon-zkevm";

export type OwnerSource = "deployer" | "owner" | "admin" | "default_admin_role" | "manual";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export type ConfidenceFilter = "ALL" | "HIGH_ONLY";

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
  matchedFunctions: string[];
  txHash: `0x${string}`;
  blockNumber: bigint;
  detectedAt: Date;
}

export interface ChatSettingsRecord {
  chatId: string;
  confidenceFilter: ConfidenceFilter;
  networksFilter: NetworkKey[] | null;
  createdAt: Date;
}

export interface MigrationAnalysisResult {
  confidence: ConfidenceLevel;
  tokenBAddress: `0x${string}` | null;
  tokenBSource: "constructor_args" | "static_call" | null;
  matchedFunctions: string[];
}

export interface ContractCreationEvent {
  network: NetworkKey;
  contractAddress: `0x${string}`;
  creatorAddress: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: bigint;
  input: `0x${string}`;
}
