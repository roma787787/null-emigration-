// End-to-end check of the real pipeline (block listener -> BullMQ -> analyzer ->
// Postgres -> alert card) against a local anvil chain. Needs anvil on :8545
// plus Postgres and Redis — see README "End-to-end test".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

process.env.DATABASE_URL ??= "postgres://tracker:tracker@localhost:5432/migration_tracker";
process.env.REDIS_URL ??= "redis://localhost:6379";
// The local chain is declared exactly the way an operator adds a new network
// in production (EXTRA_NETWORKS), so this also exercises that path.
const NETWORK = "anvil";
process.env.EXTRA_NETWORKS = NETWORK;
process.env.NETWORK_ANVIL_CHAIN_ID = "31337";
process.env.NETWORK_ANVIL_NAME = "Anvil (local)";
process.env.RPC_ANVIL ??= "ws://127.0.0.1:8545,http://127.0.0.1:8545";
process.env.ENABLED_NETWORKS = NETWORK;
process.env.LOG_LEVEL ??= "warn";
process.env.NODE_ENV = "production";

const ARTIFACTS = process.env.E2E_ARTIFACTS ?? fileURLToPath(new URL("./artifacts.json", import.meta.url));
const artifacts = JSON.parse(readFileSync(ARTIFACTS, "utf8")) as Record<string, { abi: Abi; bytecode: Hex }>;

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const STRANGER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const { runMigrations } = await import("../src/db/migrate.js");
const { pool } = await import("../src/db/client.js");
const { tokenRepository } = await import("../src/db/repositories/tokenRepository.js");
const { ownerRepository } = await import("../src/db/repositories/ownerRepository.js");
const { discoverAllOwners } = await import("../src/chain/ownerDiscovery.js");
const { startBlockListener } = await import("../src/chain/blockListener.js");
const { enqueueContractCreation, startContractCreationWorker, getContractCreationQueue } = await import(
  "../src/queue/notificationQueue.js"
);
const { formatMigrationAlert } = await import("../src/telegram/notificationFormatter.js");
const { analyzeDeployTx } = await import("../src/analyzer/analyzeDeployTx.js");

const rpc = http("http://127.0.0.1:8545");
const chainClient = createPublicClient({ chain: foundry, transport: rpc });
const owner = createWalletClient({ account: privateKeyToAccount(OWNER_KEY), chain: foundry, transport: rpc });
const stranger = createWalletClient({ account: privateKeyToAccount(STRANGER_KEY), chain: foundry, transport: rpc });

async function deploy(wallet: typeof owner, name: string, args: unknown[] = []): Promise<{ address: Address; hash: Hex }> {
  const { abi, bytecode } = artifacts[name]!;
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const receipt = await chainClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, hash };
}

// --- reset state -----------------------------------------------------------
await runMigrations();
await pool.query("TRUNCATE tokens, chat_settings RESTART IDENTITY CASCADE");
await getContractCreationQueue().obliterate({ force: true });

// --- Token A / Token B, then simulate /add_token ---------------------------
const oldToken = await deploy(owner, "SimpleToken", ["Old Token", "OLD", 10n ** 24n]);
const newToken = await deploy(owner, "SimpleToken", ["New Token", "NEW", 10n ** 24n]);
// A second tracked token owned by the same wallet: every detection that
// references Token A must still be attributed (it's registered first, so a naive first-match pick would choose it) to Token A, not this decoy.
const decoyToken = await deploy(owner, "SimpleToken", ["Decoy", "DCY", 10n ** 24n]);
const decoy = await tokenRepository.add(NETWORK, decoyToken.address, "e2e-chat", { symbol: "DCY", name: "Decoy" });
await ownerRepository.upsert(decoy.id, owner.account.address, "owner");
const token = await tokenRepository.add(NETWORK, oldToken.address, "e2e-chat", { symbol: "OLD", name: "Old Token" });
const owners = await discoverAllOwners(NETWORK, oldToken.address);
for (const o of owners) await ownerRepository.upsert(token.id, o.address, o.source);
console.log(`Token A ${oldToken.address}, Token B ${newToken.address}, decoy ${decoyToken.address}`);
console.log("Discovered owners:", owners.map((o) => `${o.address} (${o.source})`).join(", ") || "none");

// Let the token deploys fall into already-finished blocks before listening.
const startBlock = await chainClient.getBlockNumber();
while ((await chainClient.getBlockNumber()) < startBlock + 2n) await new Promise((r) => setTimeout(r, 200));

// --- pipeline ---------------------------------------------------------------
type Result = { address: string; tokenA: string; confidence: string; score: number; source: string | null; tokenB: string | null; at: number; card: string };
const results = new Map<string, Result>();
const sentAt = new Map<string, number>();

startContractCreationWorker(async ({ token: tk, migrationContract: mc }) => {
  results.set(mc.contractAddress.toLowerCase(), {
    address: mc.contractAddress,
    tokenA: tk.address,
    confidence: mc.confidence,
    score: mc.confidenceScore,
    source: mc.tokenBSource,
    tokenB: mc.tokenBAddress,
    at: Date.now(),
    card: formatMigrationAlert(tk, mc, "ru"),
  });
});
startBlockListener(NETWORK, (event) => enqueueContractCreation(event));
await new Promise((r) => setTimeout(r, 1500));

// --- scenarios --------------------------------------------------------------
type Case = { label: string; address: Address; expect: { confidence?: string; tokenB?: Address | null; source?: string; detected: boolean; attributedToTokenA?: boolean } };
const cases: Case[] = [];
async function run(label: string, wallet: typeof owner, name: string, args: unknown[], expect: Case["expect"]) {
  const t0 = Date.now();
  const d = await deploy(wallet, name, args);
  sentAt.set(d.address.toLowerCase(), t0);
  cases.push({ label, address: d.address, expect });
  return d;
}

const gettersDeploy = await run("getters+migrate+event", owner, "MigratorWithGetters", [oldToken.address, newToken.address], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, attributedToTokenA: true,
});
await run("private storage, tokens only in ctor args", owner, "MigratorPrivate", [oldToken.address, newToken.address], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, source: "constructor_args", attributedToTokenA: true,
});
await run("ctor has only Token A (+ a non-token addr)", owner, "MigratorPrivate", [oldToken.address, stranger.account.address], {
  detected: true, confidence: "HIGH", tokenB: null, source: "token_a_match", attributedToTokenA: true,
});
await run("claim() but no token configured", owner, "MigratorUnconfigured", [], { detected: true, confidence: "MEDIUM", tokenB: null });
await run("unrelated Counter", owner, "Counter", [], { detected: true, confidence: "LOW", tokenB: null });
await run("Counter from a NON-owner wallet", stranger, "Counter", [], { detected: false });
const factory = await run("the factory contract itself", owner, "MigratorFactory", [], { detected: true });

// Factory call -> internal CREATE2
const salt = ("0x" + "11".repeat(32)) as Hex;
const { abi: factoryAbi } = artifacts.MigratorFactory!;
const predicted = (
  await chainClient.simulateContract({
    account: owner.account, address: factory.address, abi: factoryAbi, functionName: "deploy",
    args: [oldToken.address, newToken.address, salt],
  })
).result as Address;
const t0 = Date.now();
const callHash = await owner.writeContract({
  address: factory.address, abi: factoryAbi, functionName: "deploy", args: [oldToken.address, newToken.address, salt],
} as never);
await chainClient.waitForTransactionReceipt({ hash: callHash });
sentAt.set(predicted.toLowerCase(), t0);
cases.push({ label: "CREATE2 child via factory call", address: predicted, expect: { detected: true, confidence: "HIGH", tokenB: newToken.address, attributedToTokenA: true } });

// --- wait & report ------------------------------------------------------------
const expectedDetections = cases.filter((c) => c.expect.detected).length;
const deadline = Date.now() + 30_000;
while (results.size < expectedDetections && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 3000)); // catch any unexpected extra detections

let failures = 0;
console.log("\n=== RESULTS ===");
for (const c of cases) {
  const r = results.get(c.address.toLowerCase());
  const problems: string[] = [];
  if (c.expect.detected !== Boolean(r)) problems.push(`detected=${Boolean(r)} expected ${c.expect.detected}`);
  if (r && c.expect.confidence && r.confidence !== c.expect.confidence) problems.push(`confidence ${r.confidence} != ${c.expect.confidence}`);
  if (r && c.expect.tokenB !== undefined && (r.tokenB?.toLowerCase() ?? null) !== (c.expect.tokenB?.toLowerCase() ?? null))
    problems.push(`tokenB ${r.tokenB} != ${c.expect.tokenB}`);
  if (r && c.expect.source && r.source !== c.expect.source) problems.push(`source ${r.source} != ${c.expect.source}`);
  if (r && c.expect.attributedToTokenA && r.tokenA.toLowerCase() !== oldToken.address.toLowerCase())
    problems.push(`attributed to ${r.tokenA}, not Token A`);
  if (problems.length) failures++;
  const latency = r ? `${((r.at - sentAt.get(c.address.toLowerCase())!) / 1000).toFixed(1)}s` : "-";
  console.log(
    `${problems.length ? "FAIL" : "ok  "} ${c.label.padEnd(44)} ${r ? `${r.confidence} ${r.score}% src=${r.source ?? "-"}` : "not detected"}  latency=${latency}${problems.length ? "  <- " + problems.join("; ") : ""}`,
  );
}
const unexpected = [...results.keys()].filter((a) => !cases.some((c) => c.address.toLowerCase() === a));
if (unexpected.length) { failures++; console.log("FAIL unexpected detections:", unexpected.join(", ")); }

console.log("\n=== SAMPLE CARD (ru, getters case) ===\n" + results.get(cases[0]!.address.toLowerCase())?.card);
console.log("\n=== SAMPLE CARD (ru, Token-A-only case) ===\n" + results.get(cases[2]!.address.toLowerCase())?.card);
// --- /analyze core on already-mined transactions ------------------------------
console.log("\n=== /analyze (analyzeDeployTx) ===");
const tokenA = async () => oldToken.address;
const { abi: tokenAbi } = artifacts.SimpleToken!;
const transferHash = await owner.writeContract({
  address: oldToken.address, abi: tokenAbi, functionName: "transfer", args: [stranger.account.address, 1n],
} as never);
await chainClient.waitForTransactionReceipt({ hash: transferHash });

const analyzeChecks: Array<{ label: string; run: () => Promise<string | null> }> = [
  {
    label: "direct deploy tx -> HIGH, Token B via getter",
    run: async () => {
      const r = await analyzeDeployTx(NETWORK, gettersDeploy.hash, tokenA);
      if (r.status !== "ok") return `status ${r.status}`;
      const a = r.deployments[0]?.analysis;
      return a?.confidence === "HIGH" && a.tokenBAddress?.toLowerCase() === newToken.address.toLowerCase() ? null : `got ${a?.confidence} tokenB=${a?.tokenBAddress}`;
    },
  },
  {
    label: "factory call tx -> finds the CREATE2 child",
    run: async () => {
      const r = await analyzeDeployTx(NETWORK, callHash, tokenA);
      if (r.status !== "ok") return `status ${r.status}`;
      return r.deployments[0]?.contractAddress.toLowerCase() === predicted.toLowerCase() && r.deployments[0].analysis.confidence === "HIGH"
        ? null : `got ${r.deployments[0]?.contractAddress} ${r.deployments[0]?.analysis.confidence}`;
    },
  },
  {
    label: "plain token transfer -> no_contract",
    run: async () => { const r = await analyzeDeployTx(NETWORK, transferHash, tokenA); return r.status === "no_contract" ? null : `status ${r.status}`; },
  },
  {
    label: "unknown hash -> not_found",
    run: async () => { const r = await analyzeDeployTx(NETWORK, ("0x" + "ab".repeat(32)) as Hex, tokenA); return r.status === "not_found" ? null : `status ${r.status}`; },
  },
];
for (const check of analyzeChecks) {
  const problem = await check.run().catch((err: Error) => `threw ${err.message}`);
  if (problem) failures++;
  console.log(`${problem ? "FAIL" : "ok  "} ${check.label}${problem ? "  <- " + problem : ""}`);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
