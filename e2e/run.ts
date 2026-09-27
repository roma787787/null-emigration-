// End-to-end check of the real pipeline (block listener -> BullMQ -> analyzer ->
// Postgres -> alert card) against a local anvil chain. Needs anvil on :8545
// plus Postgres and Redis — see README "End-to-end test".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  createPublicClient,
  encodeFunctionData,
  http,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
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
// Re-check contracts without Token B every few seconds instead of minutes.
process.env.RECHECK_DELAYS_SEC = "4,8,12,16,20";

// Local stand-in for the public 4-byte signature DB (same response shape as
// api.4byte.sourcify.dev), so function-name recognition runs offline too.
const KNOWN_SIGNATURES = [
  "migrateFromLEND(uint256)", "LEND()", "AAVE()", "LEND_AAVE_RATIO()", "REVISION()",
  "mkrToSky(address,uint256)", "mkr()", "sky()", "rate()",
  "migrate(uint256)", "unmigrate(uint256)", "matic()", "polygonEcosystemToken()", "initialize(address,address)",
  "redeem(uint256)", "issue(uint256)", "totalSupply()", "balanceOf(address)", "transfer(address,uint256)",
  "owner()", "name()", "symbol()", "newToken()", "oldToken()", "newTokenSymbol()",
];
const signatureBySelector = new Map(KNOWN_SIGNATURES.map((sig) => [toFunctionSelector(sig), sig]));
let signatureDbHits = 0;
const signatureDb = createServer((req, res) => {
  signatureDbHits++;
  const selectors = (new URL(req.url ?? "/", "http://x").searchParams.get("function") ?? "").split(",");
  const fn: Record<string, Array<{ name: string; filtered: boolean }>> = {};
  for (const sel of selectors) {
    const name = signatureBySelector.get(sel as Hex);
    fn[sel] = name ? [{ name, filtered: false }] : [];
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result: { event: {}, function: fn } }));
});
await new Promise<void>((r) => signatureDb.listen(8547, "127.0.0.1", r));
process.env.SIGNATURE_DB_URL = "http://127.0.0.1:8547/signature-database/v1/lookup";

const ARTIFACTS = process.env.E2E_ARTIFACTS ?? fileURLToPath(new URL("./artifacts.json", import.meta.url));
const artifacts = JSON.parse(readFileSync(ARTIFACTS, "utf8")) as Record<string, { abi: Abi; bytecode: Hex }>;

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const STRANGER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const NEW_OWNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

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
const { readTokenSymbol } = await import("../src/chain/tokenMetadata.js");
const { probeZeroArgTokenGetters } = await import("../src/analyzer/genericTokenProbe.js");
const { refreshAllOwners } = await import("../src/chain/ownerRefresh.js");
const { collectStatus, formatStatus } = await import("../src/telegram/commands/status.js");

const rpc = http("http://127.0.0.1:8545");
const chainClient = createPublicClient({ chain: foundry, transport: rpc });
const owner = createWalletClient({ account: privateKeyToAccount(OWNER_KEY), chain: foundry, transport: rpc });
const stranger = createWalletClient({ account: privateKeyToAccount(STRANGER_KEY), chain: foundry, transport: rpc });
const newOwner = createWalletClient({ account: privateKeyToAccount(NEW_OWNER_KEY), chain: foundry, transport: rpc });

async function deploy(wallet: typeof owner, name: string, args: unknown[] = []): Promise<{ address: Address; hash: Hex }> {
  const { abi, bytecode } = artifacts[name]!;
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const receipt = await chainClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, hash };
}

// --- reset state -----------------------------------------------------------
await runMigrations();
await pool.query("TRUNCATE tokens, chat_settings, network_cursors RESTART IDENTITY CASCADE");
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

// MKR-style Token A whose symbol() is bytes32 — must read as "MKR", not UNKNOWN.
const mkrToken = await deploy(owner, "Bytes32Token", [10n ** 24n]);
const mkrSymbol = await readTokenSymbol(chainClient as never, mkrToken.address);
const mkr = await tokenRepository.add(NETWORK, mkrToken.address, "e2e-chat", { symbol: mkrSymbol, name: "Maker" });
await ownerRepository.upsert(mkr.id, owner.account.address, "owner");

// Let the token deploys fall into already-finished blocks before listening.
const startBlock = await chainClient.getBlockNumber();
while ((await chainClient.getBlockNumber()) < startBlock + 2n) await new Promise((r) => setTimeout(r, 200));

// --- pipeline ---------------------------------------------------------------
type Result = { address: string; tokenA: string; getter: string | null; confidence: string; score: number; source: string | null; tokenB: string | null; at: number; card: string };
const results = new Map<string, Result>();
const sentAt = new Map<string, number>();

const updates = new Map<string, { tokenB: string | null; confidence: string; card: string }>();

startContractCreationWorker(async ({ token: tk, migrationContract: mc, update }) => {
  if (update) {
    updates.set(mc.contractAddress.toLowerCase(), {
      tokenB: mc.tokenBAddress, confidence: mc.confidence, card: formatMigrationAlert(tk, mc, "ru", { update: true }),
    });
    return;
  }
  results.set(mc.contractAddress.toLowerCase(), {
    address: mc.contractAddress,
    tokenA: tk?.address ?? mc.tokenAAddress ?? "",
    getter: mc.matchedGetter,
    confidence: mc.confidence,
    score: mc.confidenceScore,
    source: mc.tokenBSource,
    tokenB: mc.tokenBAddress,
    at: Date.now(),
    card: formatMigrationAlert(tk, mc, "ru"),
  });
});
const listen = () => startBlockListener(NETWORK, (event) => enqueueContractCreation(event));
let stopListener = listen();
await new Promise((r) => setTimeout(r, 1500));

// --- scenarios --------------------------------------------------------------
type Case = { label: string; address: Address; expect: { confidence?: string; tokenB?: Address | null; source?: string; detected: boolean; attributedTo?: Address; getter?: string } };
const cases: Case[] = [];
async function run(label: string, wallet: typeof owner, name: string, args: unknown[], expect: Case["expect"]) {
  const t0 = Date.now();
  const d = await deploy(wallet, name, args);
  sentAt.set(d.address.toLowerCase(), t0);
  cases.push({ label, address: d.address, expect });
  return d;
}

const gettersDeploy = await run("getters+migrate+event", owner, "MigratorWithGetters", [oldToken.address, newToken.address], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, attributedTo: oldToken.address,
});
await run("private storage, tokens only in ctor args", owner, "MigratorPrivate", [oldToken.address, newToken.address], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, source: "constructor_args", attributedTo: oldToken.address,
});
await run("ctor has only Token A (+ a non-token addr)", owner, "MigratorPrivate", [oldToken.address, stranger.account.address], {
  detected: true, confidence: "HIGH", tokenB: null, source: "token_a_match", attributedTo: oldToken.address,
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
cases.push({ label: "CREATE2 child via factory call", address: predicted, expect: { detected: true, confidence: "HIGH", tokenB: newToken.address, attributedTo: oldToken.address } });

// Proxies: the migrate()/Migrated code lives only in the implementation.
const impl = await run("proxy implementation (uninitialized logic)", owner, "MigratorUpgradeable", [], {
  detected: true, confidence: "MEDIUM", tokenB: null,
});
const initData = encodeFunctionData({
  abi: artifacts.MigratorUpgradeable!.abi, functionName: "initialize", args: [oldToken.address, newToken.address],
});
await run("EIP-1967 proxy initialized with (A, B)", owner, "SimpleProxy", [impl.address, initData], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, source: "static_call", attributedTo: oldToken.address,
});
const cloneFactory = await run("clone factory contract itself", owner, "CloneFactory", [], { detected: true, confidence: "LOW" });
const { abi: cloneAbi } = artifacts.CloneFactory!;
const clonePredicted = (
  await chainClient.simulateContract({
    account: owner.account, address: cloneFactory.address, abi: cloneAbi, functionName: "clone", args: [impl.address],
  })
).result as Address;
const tClone = Date.now();
const cloneHash = await owner.writeContract({
  address: cloneFactory.address, abi: cloneAbi, functionName: "clone", args: [impl.address],
} as never);
await chainClient.waitForTransactionReceipt({ hash: cloneHash });
sentAt.set(clonePredicted.toLowerCase(), tClone);
cases.push({ label: "EIP-1167 clone of the migrator (via factory)", address: clonePredicted, expect: { detected: true, confidence: "MEDIUM", tokenB: null } });

// Real-world shapes: project-specific names no fixed list covers.
const lendImpl = await run("Aave-style impl: migrateFromLEND, LEND()/AAVE()", owner, "LendStyleMigrator",
  [oldToken.address, newToken.address], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, source: "static_call", getter: "AAVE", attributedTo: oldToken.address,
});
await run("Aave-style: same migrator behind an EIP-1967 proxy", owner, "SimpleProxy", [lendImpl.address, "0x"], {
  // Token addresses live only in the implementation's immutables here.
  detected: true, confidence: "HIGH", tokenB: newToken.address, getter: "AAVE", attributedTo: oldToken.address,
});
await run("Sky-style converter: mkrToSky, bytes32 MKR", owner, "SkyStyleConverter",
  [mkrToken.address, newToken.address, 24_000n], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, attributedTo: mkrToken.address,
});
const polImpl = await run("Polygon-style logic (uninitialized)", owner, "PolStyleMigration", [], {
  detected: true, confidence: "MEDIUM", tokenB: null,
});
const polInit = encodeFunctionData({
  abi: artifacts.PolStyleMigration!.abi, functionName: "initialize", args: [oldToken.address, newToken.address],
});
await run("Polygon-style: proxy, polygonEcosystemToken()", owner, "SimpleProxy", [polImpl.address, polInit], {
  detected: true, confidence: "HIGH", tokenB: newToken.address, getter: "polygonEcosystemToken", attributedTo: oldToken.address,
});
await run("USDT-style token with redeem() (control)", owner, "UsdtStyleToken", [10n ** 24n], {
  detected: true, confidence: "LOW", tokenB: null,
});
await run("Token B named only by ticker (newTokenSymbol) → LOW", owner, "SymbolOnlyMigrator", [oldToken.address], {
  detected: true, confidence: "LOW", tokenB: null,
});

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
  if (r && c.expect.attributedTo && r.tokenA.toLowerCase() !== c.expect.attributedTo.toLowerCase())
    problems.push(`attributed to ${r.tokenA}, not ${c.expect.attributedTo}`);
  if (r && c.expect.getter && r.getter !== c.expect.getter) problems.push(`getter ${r.getter} != ${c.expect.getter}`);
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
const tokenA = async () => [oldToken.address];
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

// --- reliability: restart catch-up, re-check, owner refresh, /status ------------
console.log("\n=== reliability ===");
const waitFor = async (cond: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  return cond();
};
const reliabilityChecks: Array<[string, string | null]> = [];

// 1. A deploy mined while the bot is down (redeploy/crash) is caught on restart.
await stopListener();
const whileDown = await deploy(owner, "MigratorWithGetters", [oldToken.address, newToken.address]);
const downHead = await chainClient.getBlockNumber();
while ((await chainClient.getBlockNumber()) < downHead + 3n) await new Promise((r) => setTimeout(r, 200));
stopListener = listen();
reliabilityChecks.push([
  "deploy mined while the listener was stopped is caught after restart",
  (await waitFor(() => results.has(whileDown.address.toLowerCase()), 20_000)) ? null : "not detected",
]);

// 2. Logic deployed first (MEDIUM, no Token B) and initialized later -> update alert.
const { abi: polAbi } = artifacts.PolStyleMigration!;
const initHash = await owner.writeContract({
  address: polImpl.address, abi: polAbi, functionName: "initialize", args: [oldToken.address, newToken.address],
} as never);
await chainClient.waitForTransactionReceipt({ hash: initHash });
const polKey = polImpl.address.toLowerCase();
const gotUpdate = await waitFor(() => updates.has(polKey), 40_000);
const polUpdate = updates.get(polKey);
reliabilityChecks.push([
  "contract initialized after deploy -> re-check sends an update with Token B",
  !gotUpdate
    ? "no update alert"
    : polUpdate!.tokenB?.toLowerCase() !== newToken.address.toLowerCase()
      ? `update tokenB ${polUpdate!.tokenB}`
      : null,
]);
const spuriousUpdates = [...updates.keys()].filter((a) => a !== polKey);
reliabilityChecks.push([
  "re-checks of unchanged contracts send nothing",
  spuriousUpdates.length ? `unexpected updates: ${spuriousUpdates.join(", ")}` : null,
]);

// 3. Ownership moves to a new wallet -> periodic refresh links it -> its deploys are caught.
const { abi: simpleTokenAbi } = artifacts.SimpleToken!;
const ownHash = await owner.writeContract({
  address: oldToken.address, abi: simpleTokenAbi, functionName: "transferOwnership", args: [newOwner.account.address],
} as never);
await chainClient.waitForTransactionReceipt({ hash: ownHash });
const refreshed: string[] = [];
await refreshAllOwners(async ({ token: tk, added }) => {
  for (const o of added) refreshed.push(`${tk.symbol}:${o.address.toLowerCase()}:${o.source}`);
});
reliabilityChecks.push([
  "owner refresh links the new owner (and only it)",
  refreshed.join() === `OLD:${newOwner.account.address.toLowerCase()}:owner` ? null : `refresh added [${refreshed.join(", ")}]`,
]);
const fromNewOwner = await deploy(newOwner, "MigratorWithGetters", [oldToken.address, newToken.address]);
const newOwnerCaught = await waitFor(() => results.has(fromNewOwner.address.toLowerCase()), 20_000);
reliabilityChecks.push([
  "deploy from the new owner wallet is detected",
  !newOwnerCaught
    ? "not detected"
    : results.get(fromNewOwner.address.toLowerCase())!.tokenA.toLowerCase() !== oldToken.address.toLowerCase()
      ? "attributed to the wrong token"
      : null,
]);

// 4. /status reflects the running listener.
const statusText = formatStatus("en", await collectStatus());
reliabilityChecks.push([
  "/status shows the network as healthy with its block and lag",
  /🟢 anvil · websocket · block \d+ · lag \d+ · \d+s ago/.test(statusText) ? null : `status:\n${statusText}`,
]);

for (const [label, problem] of reliabilityChecks) {
  if (problem) failures++;
  console.log(`${problem ? "FAIL" : "ok  "} ${label}${problem ? "  <- " + problem : ""}`);
}
if (polUpdate) console.log("\n=== SAMPLE UPDATE CARD (ru) ===\n" + polUpdate.card + "\n");

// Aave's real migrator exposes REVISION() = 3, i.e. the RIPEMD-160
// precompile's address, which answers totalSupply()/symbol() with a hash.
// Probing only that getter must not turn a precompile into "Token B".
const revisionSelector = toFunctionSelector("REVISION()");
const precompilePick = await probeZeroArgTokenGetters(
  chainClient as never, lendImpl.address, [revisionSelector], new Map([[revisionSelector, "REVISION()"]]), oldToken.address,
);
if (precompilePick) { failures++; console.log(`FAIL precompile accepted as Token B: ${precompilePick.tokenBAddress} via ${precompilePick.getter}`); }
else console.log("ok   REVISION() = 3 (precompile 0x03) rejected as Token B");

if (mkrSymbol !== "MKR") { failures++; console.log(`FAIL bytes32 symbol read as ${mkrSymbol}, expected MKR`); }
else console.log("ok   bytes32 symbol() read as MKR");
if (signatureDbHits === 0) { failures++; console.log("FAIL signature DB was never queried"); }
else console.log(`ok   signature DB queried (${signatureDbHits} requests)`);
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
