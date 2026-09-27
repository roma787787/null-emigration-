import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
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
  /** Creation code + constructor args, for follow-up analysis. */
  input: Hex;
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
  /** Token A candidates once the creator is known (an explicit token, or tracked tokens the creator owns). */
  resolveTokenACandidates: (creator: Address) => Promise<Address[]>,
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

  const tokenACandidates = await resolveTokenACandidates(tx.from);
  const deployments: AnalyzedDeployment[] = [];
  for (const { address, input } of created.slice(0, MAX_CONTRACTS_PER_TX)) {
    deployments.push({
      contractAddress: address,
      input,
      analysis: await analyzeMigrationContract(network, address, input, tokenACandidates),
    });
  }

  return { status: "ok", creator: tx.from, blockNumber: receipt.blockNumber, deployments };
}
