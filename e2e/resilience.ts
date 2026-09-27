// Resilience run: the block listener + analysis pipeline under the failures
// production sees — WebSocket drops, an RPC outage longer than viem's own
// reconnect window, blocks packed with transactions, several deploys in one
// block. The bot talks to anvil through a TCP proxy this script can cut.
// Needs anvil on :8545 plus Postgres and Redis — see README "End-to-end test".
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const PROXY_PORT = 8555;
const OUTAGE_MS = Number(process.env.OUTAGE_SEC ?? 90) * 1000;
process.env.DATABASE_URL ??= "postgres://tracker:tracker@localhost:5432/migration_tracker";
process.env.REDIS_URL ??= "redis://localhost:6379";
const NETWORK = "anvil";
process.env.EXTRA_NETWORKS = NETWORK;
process.env.NETWORK_ANVIL_CHAIN_ID = "31337";
process.env.NETWORK_ANVIL_NAME = "Anvil (local)";
// Both transports go through the proxy: an outage takes the whole provider down.
process.env.RPC_ANVIL = `ws://127.0.0.1:${PROXY_PORT},http://127.0.0.1:${PROXY_PORT}`;
process.env.ENABLED_NETWORKS = NETWORK;
process.env.LOG_LEVEL ??= "fatal";
process.env.NODE_ENV = "production";
process.env.SIGNATURE_DB_URL = "off";
process.env.RECHECK_DELAYS_SEC = "600";

// --- a TCP proxy in front of anvil that can drop or refuse connections ---------------
const liveSockets = new Set<Socket>();
const pairs = new Set<[Socket, Socket]>();
let refusing = false;
const proxy: Server = createServer((client) => {
  if (refusing) {
    client.destroy();
    return;
  }
  const upstream = connect(8545, "127.0.0.1");
  liveSockets.add(client).add(upstream);
  const pair: [Socket, Socket] = [client, upstream];
  pairs.add(pair);
  const drop = () => {
    client.destroy();
    upstream.destroy();
    liveSockets.delete(client);
    liveSockets.delete(upstream);
    pairs.delete(pair);
  };
  client.pipe(upstream).pipe(client);
  client.on("error", drop).on("close", drop);
  upstream.on("error", drop).on("close", drop);
});
await new Promise<void>((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));
// Open connections stay open but stop carrying data: a silently dead feed.
const freezeConnections = () => {
  for (const [client, upstream] of pairs) {
    client.unpipe();
    upstream.unpipe();
    client.pause();
    upstream.pause();
  }
  pairs.clear();
  liveSockets.clear();
};
const dropConnections = () => {
  for (const s of liveSockets) s.destroy();
  liveSockets.clear();
};

// --- app modules ---------------------------------------------------------------------
const { runMigrations } = await import("../src/db/migrate.js");
const { pool } = await import("../src/db/client.js");
const { tokenRepository } = await import("../src/db/repositories/tokenRepository.js");
const { ownerRepository } = await import("../src/db/repositories/ownerRepository.js");
const { startBlockListener } = await import("../src/chain/blockListener.js");
const { getListenerStatus } = await import("../src/chain/listenerStatus.js");
const { enqueueContractCreation, startContractCreationWorker, getContractCreationQueue } = await import(
  "../src/queue/notificationQueue.js"
);

type Artifact = { abi: Abi; bytecode: Hex };
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? fileURLToPath(new URL("./artifacts.json", import.meta.url));
const artifacts = JSON.parse(readFileSync(ARTIFACTS, "utf8")) as Record<string, Artifact>;

// The test itself talks to anvil directly, never through the proxy.
const rpc = http("http://127.0.0.1:8545");
const chain = createPublicClient({ chain: foundry, transport: rpc });
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: rpc });
const owner = wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const anvilRpc = (method: string, params: unknown[] = []) => chain.request({ method, params } as never);

async function deploy(from: typeof owner, name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifacts[name]!;
  const hash = await from.deployContract({ abi, bytecode, args } as never);
  const receipt = await chain.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, hash, block: receipt.blockNumber };
}

await runMigrations();
await pool.query("TRUNCATE tokens, chat_settings, network_cursors RESTART IDENTITY CASCADE");
await getContractCreationQueue().obliterate({ force: true });

const oldToken = await deploy(owner, "SimpleToken", ["Old Token", "OLD", 10n ** 24n]);
const newToken = await deploy(owner, "SimpleToken", ["New Token", "NEW", 10n ** 24n]);
const token = await tokenRepository.add(NETWORK, oldToken.address, "chat", { symbol: "OLD", name: "Old Token" });
await ownerRepository.upsert(token.id, owner.account.address, "owner");

const detected = new Map<string, number>();
const worker = startContractCreationWorker(async ({ migrationContract }) => {
  detected.set(migrationContract.contractAddress.toLowerCase(), Date.now());
});
const stopListener = startBlockListener(NETWORK, (event) => enqueueContractCreation(event));
await new Promise((r) => setTimeout(r, 2000));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  <- ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
async function waitDetected(address: Address, ms: number): Promise<number | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const at = detected.get(address.toLowerCase());
    if (at) return at;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
const migrator = () => deploy(owner, "MigratorWithGetters", [oldToken.address, newToken.address]);

// 0. Baseline.
let d = await migrator();
check("baseline: deploy detected through the proxy", (await waitDetected(d.address, 15_000)) !== null);

// 1. Connections dropped once (a provider-side disconnect).
dropConnections();
await new Promise((r) => setTimeout(r, 500));
let t0 = Date.now();
d = await migrator();
let at = await waitDetected(d.address, 30_000);
check(`short WebSocket drop: next deploy still detected (${at ? ((at - t0) / 1000).toFixed(1) + "s" : "never"})`, at !== null);

// 2. Provider down for OUTAGE_SEC (default 90s) — far beyond viem's ~10s reconnect window — with a
// deploy mined during the outage and another one after it.
refusing = true;
dropConnections();
const duringOutage = await migrator();
await new Promise((r) => setTimeout(r, OUTAGE_MS));
refusing = false;
t0 = Date.now();
at = await waitDetected(duringOutage.address, 60_000);
check(`${OUTAGE_MS / 1000}s outage: deploy mined during it detected after recovery (${at ? ((at - t0) / 1000).toFixed(1) + "s" : "never"})`, at !== null);
t0 = Date.now();
d = await migrator();
at = await waitDetected(d.address, 30_000);
check(`${OUTAGE_MS / 1000}s outage: live detection resumes afterwards (${at ? ((at - t0) / 1000).toFixed(1) + "s" : "never"})`, at !== null);
const status = getListenerStatus(NETWORK);
const head = await chain.getBlockNumber();
check(
  "listener is caught up with the chain head after the outage",
  status?.lastProcessedBlock !== null && status !== undefined && head - status.lastProcessedBlock! <= 2n,
  { head: head.toString(), processed: status?.lastProcessedBlock?.toString() },
);

// 3. The WebSocket stays open but goes silent (no close, no error) — only
// the watchdog can notice. New connections still work.
freezeConnections();
t0 = Date.now();
d = await migrator();
at = await waitDetected(d.address, 120_000);
check(`silently frozen WebSocket: deploy still detected (${at ? ((at - t0) / 1000).toFixed(1) + "s" : "never"})`, at !== null);
t0 = Date.now();
d = await migrator();
at = await waitDetected(d.address, 30_000);
check(`…and after the restart, live detection is fast again (${at ? ((at - t0) / 1000).toFixed(1) + "s" : "never"})`, at !== null && at - t0 < 10_000);
const restarts = getListenerStatus(NETWORK)?.restarts ?? 0;
check(`watchdog restarted the feed (${restarts} time(s)) and /status counts it`, restarts >= 1, restarts);

// 4. A packed block: 300 unrelated transactions plus two owner deploys in the same block.
await anvilRpc("evm_setIntervalMining", [0]);
await anvilRpc("evm_setAutomine", [false]);
const nonce = await chain.getTransactionCount({ address: stranger.account.address, blockTag: "pending" });
for (let i = 0; i < 300; i++) {
  await stranger.sendTransaction({ to: owner.account.address, value: 1n, nonce: nonce + i } as never);
}
const { abi: migAbi, bytecode: migCode } = artifacts.MigratorWithGetters!;
const ownerNonce = await chain.getTransactionCount({ address: owner.account.address, blockTag: "pending" });
const h1 = await owner.deployContract({ abi: migAbi, bytecode: migCode, args: [oldToken.address, newToken.address], nonce: ownerNonce } as never);
const h2 = await owner.deployContract({ abi: migAbi, bytecode: migCode, args: [oldToken.address, newToken.address], nonce: ownerNonce + 1 } as never);
t0 = Date.now();
await anvilRpc("evm_mine");
await anvilRpc("evm_setAutomine", [true]);
await anvilRpc("evm_setIntervalMining", [1]);
const [r1, r2] = await Promise.all([chain.waitForTransactionReceipt({ hash: h1 }), chain.waitForTransactionReceipt({ hash: h2 })]);
const packed = await chain.getBlock({ blockNumber: r1.blockNumber });
check(`packed block really holds ${packed.transactions.length} txs, both deploys in it`, packed.transactions.length >= 302 && r1.blockNumber === r2.blockNumber, {
  txs: packed.transactions.length,
});
const [a1, a2] = await Promise.all([waitDetected(r1.contractAddress!, 30_000), waitDetected(r2.contractAddress!, 30_000)]);
check(
  `both deploys in the packed block detected (${a1 && a2 ? ((Math.max(a1, a2) - t0) / 1000).toFixed(1) + "s" : "missing"})`,
  a1 !== null && a2 !== null,
);

await stopListener();
await worker.close();
proxy.close();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
