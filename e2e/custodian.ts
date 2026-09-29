// RWA custodian watch (spec task 4 — Robinhood / Dinari / Backed): on a
// network without auto-discovery the bot doesn't read blocks at all, it polls
// the custodians' transaction counts and reads only the blocks where one of
// them deployed something. Needs anvil on :8545 plus Postgres and Redis — see
// README "End-to-end test".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

process.env.DATABASE_URL ??= "postgres://tracker:tracker@localhost:5432/migration_tracker";
process.env.REDIS_URL ??= "redis://localhost:6379";
const NETWORK = "anvil";
process.env.EXTRA_NETWORKS = NETWORK;
process.env.NETWORK_ANVIL_CHAIN_ID = "31337";
process.env.NETWORK_ANVIL_NAME = "Anvil (local)";
// Through a counting proxy, to see what the watch costs in RPC calls.
process.env.RPC_ANVIL = "http://127.0.0.1:8551";
process.env.LOG_LEVEL ??= "fatal";
process.env.NODE_ENV = "production";
process.env.CUSTODIAN_POLL_MS = "500";
process.env.AUTO_DEDUP_HOURS = "0"; // every migrator below shares one bytecode
process.env.RWA_LISTING_WINDOW_MS = "2500"; // new-token cards: a short batch window for the test

// --- counting RPC proxy -------------------------------------------------------------------
const calls = new Map<string, number>();
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString();
  const parsed = JSON.parse(body) as { method: string } | Array<{ method: string }>;
  for (const r of Array.isArray(parsed) ? parsed : [parsed]) calls.set(r.method, (calls.get(r.method) ?? 0) + 1);
  const upstream = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body });
  res.setHeader("content-type", "application/json");
  res.end(await upstream.text());
});
await new Promise<void>((r) => proxy.listen(8551, "127.0.0.1", r));
const snapshotCalls = () => new Map(calls);
const callsSince = (before: Map<string, number>) =>
  Object.fromEntries([...calls].map(([m, n]) => [m, n - (before.get(m) ?? 0)]).filter(([, n]) => (n as number) > 0));

// --- signature DB stub --------------------------------------------------------------------
const KNOWN = [
  "migrate(uint256)", "oldToken()", "newToken()", "rate()", "totalSupply()", "balanceOf(address)", "transfer(address,uint256)",
  "name()", "symbol()", "decimals()", "owner()", "allowance(address,address)", "approve(address,uint256)", "transferFrom(address,address,uint256)",
];
const bySelector = new Map(KNOWN.map((s) => [toFunctionSelector(s), s]));
const sigDb = createServer((req, res) => {
  const selectors = (new URL(req.url ?? "/", "http://x").searchParams.get("function") ?? "").split(",");
  const fn: Record<string, Array<{ name: string; filtered: boolean }>> = {};
  for (const s of selectors) fn[s] = bySelector.has(s as Hex) ? [{ name: bySelector.get(s as Hex)!, filtered: false }] : [];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result: { event: {}, function: fn } }));
});
await new Promise<void>((r) => sigDb.listen(8548, "127.0.0.1", r));
process.env.SIGNATURE_DB_URL = "http://127.0.0.1:8548/signature-database/v1/lookup";

// --- app modules --------------------------------------------------------------------------
const { runMigrations } = await import("../src/db/migrate.js");
const { pool } = await import("../src/db/client.js");
const { custodianRepository } = await import("../src/db/repositories/custodianRepository.js");
const { startCustodianWatcher, custodianWatchStatuses } = await import("../src/chain/custodianWatcher.js");
const q = await import("../src/queue/notificationQueue.js");
type Record_ = Awaited<ReturnType<typeof import("../src/db/repositories/migrationContractRepository.js").migrationContractRepository.findByContract>>;

type Artifact = { abi: Abi; bytecode: Hex };
const artifacts = JSON.parse(readFileSync(fileURLToPath(new URL("./artifacts.json", import.meta.url)), "utf8")) as Record<string, Artifact>;
const rpc = http("http://127.0.0.1:8545");
const chain = createPublicClient({ chain: foundry, transport: rpc });
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: rpc });
const owner = wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const operator = wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const custodian = wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const stranger = wallet("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const anvilRpc = (method: string, params: unknown[] = []) => chain.request({ method, params } as never);

async function deploy(from: typeof owner, name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifacts[name]!;
  const hash = await from.deployContract({ abi, bytecode, args } as never);
  return (await chain.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function call(from: typeof owner, to: Address, name: string, fn: string, args: unknown[]) {
  const { abi } = artifacts[name]!;
  const { result } = await chain.simulateContract({ account: from.account, address: to, abi, functionName: fn, args } as never);
  await chain.waitForTransactionReceipt({ hash: await from.writeContract({ address: to, abi, functionName: fn, args } as never) });
  return result as unknown as Address;
}

await runMigrations();
await pool.query("TRUNCATE tokens, chat_settings, network_cursors, custodians RESTART IDENTITY CASCADE");
await q.getAutoDiscoveryQueue().obliterate({ force: true });
{
  const { createRedisConnection } = await import("../src/queue/redisClient.js");
  const r = createRedisConnection();
  const stale = await r.keys("rwa:listing:*");
  if (stale.length) await r.del(...stale);
  r.disconnect();
}
const { ListingBatcher } = await import("../src/rwa/listings.js");
type Batch = import("../src/rwa/listings.js").ListingBatch;
const listingBatches: Batch[] = [];
const listingBatcher = new ListingBatcher(async (batch) => {
  listingBatches.push(batch);
});

const oldToken = await deploy(owner, "SimpleToken", ["Classic Stock", "OLDX", 10n ** 24n]);
const newToken = await deploy(owner, "SimpleToken", ["Stock Token", "NEWX", 10n ** 24n]);
const stockFactory = await deploy(owner, "StockFactoryLike");
const create2Factory = await deploy(owner, "MigratorFactory");
const forwarder = await deploy(owner, "Forwarder");
await custodianRepository.upsert(NETWORK, custodian.account.address, "Test Custodian");
await custodianRepository.upsert(NETWORK, stockFactory, "Stock Factory");
await custodianRepository.upsert(NETWORK, create2Factory, "CREATE2 Custodian");

const lower = (a: string) => a.toLowerCase();
const alerts = new Map<string, { at: number; record: NonNullable<Record_> }>();
q.startAutoDiscoveryWorker(
  async ({ migrationContract }) => {
    alerts.set(lower(migrationContract.contractAddress), { at: Date.now(), record: migrationContract });
  },
  (listing) => listingBatcher.add(listing),
);
let stop = startCustodianWatcher(NETWORK, (e) => q.enqueueAutoCandidate(e));
await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  <- ${typeof detail === "string" ? detail : JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`}`);
}
async function waitFor(address: Address, ms = 15_000) {
  const until = Date.now() + ms;
  while (!alerts.has(lower(address)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return alerts.get(lower(address));
}
async function expectCustodianAlert(label: string, address: Address, custodianLabel: string, t0: number) {
  const a = await waitFor(address);
  const latency = a ? (a.at - t0) / 1000 : Infinity;
  check(
    `${label} [${a?.record.confidence ?? "-"}] latency=${latency.toFixed(1)}s`,
    !!a && a.record.discovery === "custodian" && a.record.custodianLabel === custodianLabel && lower(a.record.tokenAAddress ?? "") === lower(oldToken) && latency <= 10,
    a ? { discovery: a.record.discovery, label: a.record.custodianLabel, tokenA: a.record.tokenAAddress, latency } : "no alert",
  );
}

// --- idle cost: blocks keep coming, custodians do nothing ---------------------------------
{
  const before = snapshotCalls();
  const blockBefore = await chain.getBlockNumber();
  await new Promise((r) => setTimeout(r, 6000));
  const blocks = Number((await chain.getBlockNumber()) - blockBefore);
  const used = callsSince(before);
  check(
    `idle: ${blocks} new blocks, not one read — only head + 3 custodian counts per poll (${JSON.stringify(used)})`,
    blocks >= 4 && !used.eth_getBlockByNumber && !used.trace_block && !used.debug_traceTransaction,
    used,
  );
}

// --- deployments ----------------------------------------------------------------------------
{
  const t0 = Date.now();
  const address = await deploy(custodian, "MigratorWithGetters", [oldToken, newToken]);
  await expectCustodianAlert("custodian wallet deploys a migration contract directly", address, "Test Custodian", t0);
}
{
  const t0 = Date.now();
  const address = await call(operator, stockFactory, "StockFactoryLike", "deployMigrator", [oldToken, newToken]);
  await expectCustodianAlert("operator calls the custodian's StockFactory (CREATE) → migration alerted as the factory's", address, "Stock Factory", t0);
}
{
  const t0 = Date.now();
  const data = encodeFunctionData({ abi: artifacts.StockFactoryLike!.abi, functionName: "deployMigrator", args: [oldToken, newToken] });
  const { result } = await chain.simulateContract({ account: operator.account, address: stockFactory, abi: artifacts.StockFactoryLike!.abi, functionName: "deployMigrator", args: [oldToken, newToken] } as never);
  await chain.waitForTransactionReceipt({ hash: await operator.writeContract({ address: forwarder, abi: artifacts.Forwarder!.abi, functionName: "forward", args: [stockFactory, data] } as never) });
  await expectCustodianAlert("factory reached through a multisig/forwarder (tx not addressed to it) → still found", result as Address, "Stock Factory", t0);
}
{
  const t0 = Date.now();
  const address = await call(operator, create2Factory, "MigratorFactory", "deploy", [oldToken, newToken, ("0x" + "55".repeat(32)) as Hex]);
  await expectCustodianAlert("custodian factory deploying with CREATE2", address, "CREATE2 Custodian", t0);
}
const listed = () => listingBatches.flatMap((b) => b.listings.map((l) => lower(l.address)));
{
  const before = custodianWatchStatuses()[0]!.deployments;
  const t0 = Date.now();
  const stock = await call(operator, stockFactory, "StockFactoryLike", "deployStock", ["Apple Stock Token", "AAPL"]);
  const outsider = await deploy(stranger, "MigratorWithGetters", [oldToken, newToken]);
  const until = Date.now() + 15_000;
  while (!listed().includes(lower(stock)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const batch = listingBatches.find((b) => b.listings.some((l) => lower(l.address) === lower(stock)));
  const listing = batch?.listings[0];
  check(
    `a new stock token from the custodian: its own "new RWA token" card (AAPL — Apple Stock Token, issuer Stock Factory) in ${((Date.now() - t0) / 1000).toFixed(1)}s, not a migration alert`,
    !!batch && batch.listings.length === 1 && listing?.symbol === "AAPL" && listing.name === "Apple Stock Token" && batch.issuer === "Stock Factory" && !alerts.has(lower(stock)),
    { batch, alerted: alerts.has(lower(stock)) },
  );
  check("…and the watch counted it", custodianWatchStatuses()[0]!.deployments > before);
  check("a migrator from a non-custodian wallet is not the watch's business (auto-discovery's)", !alerts.has(lower(outsider)));
}
{
  // A launch: 6 stock tokens in one block → one digest, not 6 cards.
  const batchesBefore = listingBatches.length;
  await anvilRpc("evm_setIntervalMining", [0]);
  const { abi } = artifacts.StockFactoryLike!;
  const hashes: Hex[] = [];
  for (const [name, symbol] of [["Tesla Stock Token", "TSLA"], ["NVIDIA Stock Token", "NVDA"], ["Microsoft Stock Token", "MSFT"], ["Amazon Stock Token", "AMZN"], ["Alphabet Stock Token", "GOOGL"], ["Meta Stock Token", "META"]]) {
    hashes.push(await operator.writeContract({ address: stockFactory, abi, functionName: "deployStock", args: [name, symbol] } as never));
  }
  await anvilRpc("evm_mine");
  await anvilRpc("evm_setIntervalMining", [1]);
  for (const hash of hashes) await chain.waitForTransactionReceipt({ hash });
  const until = Date.now() + 20_000;
  while (listingBatches.slice(batchesBefore).flatMap((b) => b.listings).length < 6 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const newBatches = listingBatches.slice(batchesBefore);
  check(
    `a launch of 6 stock tokens in one block → ${newBatches.length} message(s): one digest of ${newBatches[0]?.listings.length ?? 0} (${newBatches[0]?.listings.map((l) => l.symbol).join(", ")})`,
    newBatches.length === 1 && newBatches[0]!.listings.length === 6,
    newBatches.map((b) => b.listings.length),
  );
}
const listingsBeforeRestart = listed().length;

// --- restart: a burst of 55 deployments in 55 blocks while the bot was down ---------------
await stop();
const burst: Address[] = [];
await anvilRpc("evm_setIntervalMining", [0]);
await anvilRpc("evm_setAutomine", [true]);
const blockSet = new Set<bigint>();
for (let i = 0; i < 55; i++) {
  const { abi, bytecode } = artifacts.MigratorWithGetters!;
  const receipt = await chain.waitForTransactionReceipt({ hash: await custodian.deployContract({ abi, bytecode, args: [oldToken, newToken] } as never) });
  burst.push(receipt.contractAddress!);
  blockSet.add(receipt.blockNumber);
}
await anvilRpc("evm_setAutomine", [false]);
await anvilRpc("evm_setIntervalMining", [1]);
const burstBlocks = blockSet.size;
const restartT0 = Date.now();
const before = snapshotCalls();
stop = startCustodianWatcher(NETWORK, (e) => q.enqueueAutoCandidate(e));
const until = Date.now() + 60_000;
while (burst.some((a) => !alerts.has(lower(a))) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
const found = burst.filter((a) => alerts.has(lower(a))).length;
const used = callsSince(before);
check(
  `after a restart, all ${burst.length} deployments made while down are found (${found}/${burst.length} in ${((Date.now() - restartT0) / 1000).toFixed(1)}s, over the 50-blocks-per-poll cap)`,
  found === burst.length && burstBlocks === 55,
  { found, burstBlocks },
);
check(
  `…reading only the blocks that had one: ${used.eth_getBlockByNumber ?? 0} block reads for 55 deployments`,
  (used.eth_getBlockByNumber ?? 0) <= 60,
  used,
);
await new Promise((r) => setTimeout(r, 4000));
check(
  `migrators are not "new tokens", and nothing is announced twice after the restart (${listed().length} listed in all)`,
  listed().length === listingsBeforeRestart && new Set(listed()).size === listed().length,
  listed().length,
);
const status = custodianWatchStatuses()[0]!;
check(`/status data: custodians ${status.custodians}, deployments ${status.deployments}, no error`, status.custodians === 3 && status.deployments >= 55 && status.lastPollAt !== null, status);

await stop();
proxy.close();
sigDb.close();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
