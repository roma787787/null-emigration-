import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { MigrationAnalysisResult, NetworkKey } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { findFactoryCreatedContracts } from "../chain/traceCreateDetector.js";
import { analyzeMigrationContract } from "./migrationAnalyzer.js";

const MAX_CONTRACTS_PER_TX = 5;

export interface AnalyzedDeployment {
  contractAddress: Address;
  analysis: MigrationAnalysisResult;
}

export type DeployTxAnalysis =
  | { status: "not_found" }
  | { status: "reverted" }
  | { status: "no_contract" }
  | { status: "ok"; creator: Address; blockNumber: bigint; deployments: AnalyzedDeployment[] };

/**
 * On-demand version of what the block listener does for live blocks: take
 * an already-mined deployment transaction (direct, or a factory call that
 * CREATE/CREATE2s contracts), and run the migration analyzer on every
 * contract it created. Backs the /analyze command, so real historical
 * migration contracts can be checked without deploying anything.
 */
export async function analyzeDeployTx(
  network: NetworkKey,
  txHash: Hex,
  /** Picks Token A once the creator and creation inputs are known (e.g. a tracked token the creator owns); null if none. */
  resolveTokenA: (creator: Address, creationInputs: Hex[]) => Promise<Address | null>,
): Promise<DeployTxAnalysis> {
  const client = getPublicClient(network);

  let tx, receipt;
  try {
    [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
  } catch (err) {
    if (err instanceof TransactionNotFoundError || err instanceof TransactionReceiptNotFoundError) {
      return { status: "not_found" };
    }
    throw err;
  }

  if (receipt.status === "reverted") return { status: "reverted" };

  const created = receipt.contractAddress
    ? [{ address: receipt.contractAddress, input: tx.input }]
    : await findFactoryCreatedContracts(client, network, txHash);

  if (created.length === 0) return { status: "no_contract" };

  const tokenAAddress = await resolveTokenA(tx.from, created.map((c) => c.input));
  const deployments: AnalyzedDeployment[] = [];
  for (const { address, input } of created.slice(0, MAX_CONTRACTS_PER_TX)) {
    deployments.push({
      contractAddress: address,
      analysis: await analyzeMigrationContract(network, address, input, tokenAAddress ?? zeroAddress),
    });
  }

  return { status: "ok", creator: tx.from, blockNumber: receipt.blockNumber, deployments };
}
