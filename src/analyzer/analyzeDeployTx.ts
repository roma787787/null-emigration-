import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type Transaction,
  type TransactionReceipt,
} from "viem";
import type { MigrationAnalysisResult, NetworkKey } from "../types/index.js";
import { getPublicClient, getSingleRpcClients } from "../chain/provider.js";
import { getTransactionViaExplorer } from "../chain/ownerDiscovery.js";
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
/**
 * The transaction and its receipt: the usual client first, then each RPC on
 * its own (one may keep older history than another), then the explorer.
 * Null when none has it; throws only when every source failed outright.
 */
async function fetchTransaction(
  network: NetworkKey,
  txHash: Hex,
): Promise<{ tx: Transaction; receipt: TransactionReceipt } | null> {
  let lastError: unknown = null;
  const clients: PublicClient[] = [getPublicClient(network) as PublicClient, ...getSingleRpcClients(network)];
  for (const client of clients) {
    try {
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]);
      return { tx, receipt };
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError || err instanceof TransactionReceiptNotFoundError)) lastError = err;
    }
  }
  const viaExplorer = await getTransactionViaExplorer(network, txHash);
  if (viaExplorer) return viaExplorer;
  if (lastError) throw lastError;
  return null;
}

export async function analyzeDeployTx(
  network: NetworkKey,
  txHash: Hex,
  /** Token A candidates once the creator is known (an explicit token, or tracked tokens the creator owns). */
  resolveTokenACandidates: (creator: Address) => Promise<Address[]>,
  /**
   * The contract the caller is after (/analyze <address>): analyzed even when
   * the RPC can't trace which factory call created it.
   */
  knownContract?: Address,
): Promise<DeployTxAnalysis> {
  const client = getPublicClient(network);

  const found = await fetchTransaction(network, txHash);
  if (!found) return { status: "not_found" };
  const { tx, receipt } = found;

  if (receipt.status === "reverted") return { status: "reverted" };

  let created = receipt.contractAddress
    ? [{ address: receipt.contractAddress, input: tx.input }]
    : await findFactoryCreatedContracts(client, network, txHash);
  if (created.length === 0 && knownContract) {
    const code = await client.getCode({ address: knownContract }).catch(() => undefined);
    if (code && code !== "0x") created = [{ address: knownContract, input: "0x" }];
  }

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
