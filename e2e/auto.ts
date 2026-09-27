// Auto-discovery acceptance run (refactoring spec): the bot finds migrations
// among ALL new contracts — no /add_token — ties tokens strictly by address,
// drops pools / fee-swap tokens / base-asset pairs, filters by an OKX
// executable-route test (stubbed here), and handles CREATE2 factories, RWA
// custodians and ticker-only targets. Needs anvil on :8545 plus Postgres and
// Redis — see README "End-to-end test".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { markdownV2Problem } from "./markdownV2.js";

process.env.DATABASE_URL ??= "postgres://tracker:tracker@localhost:5432/migration_tracker";
process.env.REDIS_URL ??= "redis://localhost:6379";
const NETWORK = "anvil";
process.env.EXTRA_NETWORKS = NETWORK;
process.env.NETWORK_ANVIL_CHAIN_ID = "31337";
process.env.NETWORK_ANVIL_NAME = "Anvil (local)";
process.env.RPC_ANVIL ??= "ws://127.0.0.1:8545,http://127.0.0.1:8545";
process.env.ENABLED_NETWORKS = NETWORK;
process.env.LOG_LEVEL ??= "fatal";
process.env.NODE_ENV = "production";
process.env.RECHECK_DELAYS_SEC = "600";
process.env.AUTO_DISCOVERY = "true";

// --- signature DB stub --------------------------------------------------------------
const KNOWN = [
  "migrate(uint256)", "oldToken()", "newToken()", "rate()", "token0()", "token1()",
  "swap(uint256,uint256,address,bytes)", "getReserves()", "swapTokensForEth(uint256)", "swapBack()",
  "pairedToken()", "newTokenSymbol()", "isin()", "issuer()", "LEND()", "AAVE()", "migrateFromLEND(uint256)",
  "LEND_AAVE_RATIO()", "REVISION()", "totalSupply()", "balanceOf(address)", "transfer(address,uint256)",
  "name()", "symbol()", "decimals()", "deploy(address,address,bytes32)",
];
const bySelector = new Map(KNOWN.map((s) => [toFunctionSelector(s), s]));
const sigDb = createServer((req, res) => {
  const selectors = (new URL(req.url ?? "/", "http://x").searchParams.get("function") ?? "").split(",");
  const fn: Record<string, Array<{ name: string; filtered: boolean }>> = {};
  for (const s of selectors) fn[s] = bySelector.has(s as Hex) ? [{ name: bySelector.get(s as Hex)!, filtered: false }] : [];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result: { event: {}, function: fn } }));
});
await new Promise<void>((r) => sigDb.listen(8547, "127.0.0.1", r));
process.env.SIGNATURE_DB_URL = "http://127.0.0.1:8547/signature-database/v1/lookup";

// --- OKX DEX API stub: per Token A, the price impact for $300 and $1,000 ------------
type Market = { low: number; strict: number } | "noroute" | { failFirst: number; then: { low: number; strict: number } };
const markets = new Map<string, Market>();
const okxRequests = new Map<string, number>();
let okxSignedOk = true;
const okx = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const to = (url.searchParams.get("toTokenAddress") ?? "").toLowerCase();
  const amount = BigInt(url.searchParams.get("amount") ?? "0");
  okxRequests.set(to, (okxRequests.get(to) ?? 0) + 1);
  if (!req.headers["ok-access-sign"] || !req.headers["ok-access-key"] || !req.headers["ok-access-timestamp"]) okxSignedOk = false;
  res.setHeader("content-type", "application/json");
  let market = markets.get(to);
  if (market && typeof market === "object" && "failFirst" in market) {
    if (market.failFirst > 0) {
      market.failFirst--;
      return void res.end(JSON.stringify({ code: "50001", msg: "Service temporarily unavailable" }));
    }
    market = market.then;
  }
  if (!market || market === "noroute") return void res.end(JSON.stringify({ code: "82000", msg: "Insufficient liquidity" }));
  const impact = amount >= 1000n * 10n ** 18n ? market.strict : market.low;
  res.end(JSON.stringify({ code: "0", msg: "", data: [{ toTokenAmount: "1000", priceImpactPercent: String(-impact) }] }));
});
await new Promise<void>((r) => okx.listen(8549, "127.0.0.1", r));
Object.assign(process.env, {
  OKX_API_KEY: "test-key",
  OKX_SECRET_KEY: "test-secret",
  OKX_API_PASSPHRASE: "test-pass",
  OKX_API_BASE_URL: "http://127.0.0.1:8549",
});

// --- app modules -----------------------------------------------------------------------
const { runMigrations } = await import("../src/db/migrate.js");
const { pool } = await import("../src/db/client.js");
const { tokenRepository } = await import("../src/db/repositories/tokenRepository.js");
const { ownerRepository } = await import("../src/db/repositories/ownerRepository.js");
const { custodianRepository } = await import("../src/db/repositories/custodianRepository.js");
const { startBlockListener } = await import("../src/chain/blockListener.js");
const { autoStats } = await import("../src/chain/autoStats.js");
const q = await import("../src/queue/notificationQueue.js");
const { wantsAutoAlert } = await import("../src/telegram/bot.js");
const { formatMigrationAlert } = await import("../src/telegram/notificationFormatter.js");
const { clearLiquidityCache } = await import("../src/liquidity/okxLiquidity.js");
type Record_ = Awaited<ReturnType<typeof import("../src/db/repositories/migrationContractRepository.js").migrationContractRepository.findByContract>>;

type Artifact = { abi: Abi; bytecode: Hex };
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? fileURLToPath(new URL("./artifacts.json", import.meta.url));
const artifacts = JSON.parse(readFileSync(ARTIFACTS, "utf8")) as Record<string, Artifact>;
const rpc = http("http://127.0.0.1:8545");
const chain = createPublicClient({ chain: foundry, transport: rpc });
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: rpc });
const owner = wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const custodian = wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

async function deploy(from: typeof owner, name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifacts[name]!;
  const hash = await from.deployContract({ abi, bytecode, args } as never);
  const receipt = await chain.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}
const token = (name: string, symbol: string) => deploy(owner, "SimpleToken", [name, symbol, 10n ** 24n]);

await runMigrations();
await pool.query("TRUNCATE tokens, chat_settings, network_cursors, custodians RESTART IDENTITY CASCADE");
await q.getContractCreationQueue().obliterate({ force: true });
await q.getAutoDiscoveryQueue().obliterate({ force: true });
clearLiquidityCache();

// Market fixtures: a dollar stable to quote from, a wrapped-native base asset, tokens with and without markets.
const usd = await token("Test Dollar", "USDT");
const weth = await token("Wrapped Ether", "WETH");
process.env.QUOTE_TOKEN_ANVIL = `${usd}:18:USDT`;
process.env.BASE_ASSETS_ANVIL = weth;
const oldToken = await token("Old Token", "OLD");
const oldTwin = await token("Old Token (other project)", "OLD"); // same ticker, different token
const newToken = await token("New Token", "NEW");
const illiquid = await token("Dust", "DUST");
const thin = await token("Thin", "THIN"); // routes for $300, too much impact for $1,000
const flaky = await token("Flaky", "FLK"); // OKX fails once, then routes
const newToken2 = await token("New Token 2", "NEW2");
const lower = (a: string) => a.toLowerCase();
markets.set(lower(oldToken), { low: 0.2, strict: 0.8 });
markets.set(lower(oldTwin), { low: 0.3, strict: 1.1 });
markets.set(lower(thin), { low: 4, strict: 7 });
markets.set(lower(flaky), { failFirst: 1, then: { low: 0.5, strict: 1 } });
markets.set(lower(illiquid), "noroute");
markets.set(lower(newToken), "noroute");
markets.set(lower(newToken2), "noroute");
markets.set("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", { low: 0, strict: 0 });
markets.set(lower(weth), { low: 0, strict: 0.01 }); // deep market: only the base-asset rule can stop it

// One tracked project (the owner of OLD) for the priority path; everything else is untracked.
const tracked = await tokenRepository.add(NETWORK, oldToken, "chat", { symbol: "OLD", name: "Old Token" });
await ownerRepository.upsert(tracked.id, owner.account.address, "owner");
await custodianRepository.upsert(NETWORK, custodian.account.address, "Test Custodian");

// --- pipeline -----------------------------------------------------------------------------
const alerts = new Map<string, { at: number; record: NonNullable<Record_>; tracked: boolean }>();
q.startContractCreationWorker(async ({ migrationContract }) => {
  alerts.set(lower(migrationContract.contractAddress), { at: Date.now(), record: migrationContract, tracked: true });
});
q.startAutoDiscoveryWorker(async ({ migrationContract }) => {
  alerts.set(lower(migrationContract.contractAddress), { at: Date.now(), record: migrationContract, tracked: false });
});
const stop = startBlockListener(NETWORK, (e) => q.enqueueContractCreation(e), (e) => q.enqueueAutoCandidate(e));
await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  <- ${typeof detail === "string" ? detail : JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`}`);
}
const sent = new Map<string, number>();
async function deployTimed(from: typeof owner, name: string, args: unknown[] = []) {
  const t0 = Date.now();
  const address = await deploy(from, name, args);
  sent.set(lower(address), t0);
  return address;
}

// Chats with different settings, to check routing.
const chat = (liquidityLevel: "STRICT" | "LOW_CAP", autoAlerts = true) =>
  ({ chatId: "c", liquidityLevel, autoAlerts, confidenceFilter: "ALL", networksFilter: null, language: "en", approved: true, accessRequested: true, createdAt: new Date() }) as const;
const strictChat = chat("STRICT"), lowCapChat = chat("LOW_CAP"), trackedOnlyChat = chat("STRICT", false);

// --- scenarios ------------------------------------------------------------------------------
const cases: Array<{ label: string; address: Address; expect: (r: NonNullable<Record_> | undefined) => string | null }> = [];
const expectAlert = (fn: (r: NonNullable<Record_>) => string | null) => (r: NonNullable<Record_> | undefined) => (r ? fn(r) : "no alert");
const expectNone = (r: NonNullable<Record_> | undefined) => (r ? `unexpected alert (Token A ${r.tokenAAddress})` : null);
const eq = (a: string | null | undefined, b: string | null | undefined) => lower(a ?? "") === lower(b ?? "");

cases.push({
  label: "untracked deployer, oldToken()/newToken() + migrate: alert without /add_token",
  address: await deployTimed(stranger, "MigratorWithGetters", [oldTwin, newToken]),
  expect: expectAlert((r) =>
    r.discovery !== "auto" ? `discovery ${r.discovery}`
    : !eq(r.tokenAAddress, oldTwin) ? `Token A ${r.tokenAAddress}`
    : !eq(r.tokenBAddress, newToken) ? `Token B ${r.tokenBAddress}`
    : r.confidence !== "HIGH" ? `confidence ${r.confidence}`
    : r.liquidity?.STRICT.status !== "pass" ? `liquidity ${JSON.stringify(r.liquidity)}` : null),
});
cases.push({
  label: "ticker collision: a same-ticker 'OLD' of another project is NOT attributed to the tracked OLD",
  address: cases[0]!.address,
  expect: expectAlert((r) => (r.tokenId !== null || !eq(r.tokenAAddress, oldTwin) ? `attributed to token ${r.tokenId} / ${r.tokenAAddress}` : null)),
});
cases.push({
  label: "tracked owner's deploy still takes the priority (tracked) path",
  address: await deployTimed(owner, "MigratorWithGetters", [oldToken, newToken]),
  expect: expectAlert((r) => (r.discovery !== "tracked" || r.tokenId !== tracked.id ? `discovery ${r.discovery}, tokenId ${r.tokenId}` : null)),
});
cases.push({
  label: "Token A without an executable route (OKX: no route) → ignored",
  address: await deployTimed(stranger, "MigratorWithGetters", [illiquid, newToken]),
  expect: expectNone,
});
cases.push({
  label: "Aave-style LEND()/AAVE() + migrateFromLEND: direction from the function name",
  address: await deployTimed(stranger, "LendStyleMigrator", [oldTwin, newToken]),
  expect: expectAlert((r) => (!eq(r.tokenAAddress, oldTwin) || !eq(r.tokenBAddress, newToken) ? `A ${r.tokenAAddress} B ${r.tokenBAddress}` : null)),
});
cases.push({
  label: "tokens only in constructor args, order unknown: the one with a market becomes Token A",
  address: await deployTimed(stranger, "MigratorPrivate", [oldTwin, newToken2]),
  expect: expectAlert((r) => (!eq(r.tokenAAddress, oldTwin) || !eq(r.tokenBAddress, newToken2) ? `A ${r.tokenAAddress} B ${r.tokenBAddress}` : null)),
});
cases.push({
  label: "the new token itself has migrate() + oldToken(): Token B = the contract",
  address: await deployTimed(stranger, "MigratingToken", [oldTwin]),
  expect: expectAlert((r) => (r.tokenBSource !== "contract_itself" || !eq(r.tokenBAddress, r.contractAddress) ? `B ${r.tokenBAddress} via ${r.tokenBSource}` : null)),
});
cases.push({
  label: "Token B given only as a ticker → LOW + Unverified, never matched to a token",
  address: await deployTimed(stranger, "SymbolOnlyMigrator", [oldTwin]),
  expect: expectAlert((r) =>
    r.confidence !== "LOW" || r.tokenBSymbolUnverified !== "NEWT" || r.tokenBAddress !== null
      ? `confidence ${r.confidence}, unverified ${r.tokenBSymbolUnverified}, B ${r.tokenBAddress}` : null),
});
cases.push({ label: "DEX pair (token0/token1/swap) → ignored", address: await deployTimed(stranger, "FakePair", [oldTwin, newToken]), expect: expectNone });
cases.push({ label: "meme token with swapTokensForEth/swapBack → ignored", address: await deployTimed(stranger, "FeeToken", [oldTwin]), expect: expectNone });
cases.push({
  label: "'migration' out of WETH (a base asset) → ignored",
  address: await deployTimed(stranger, "MigratorWithGetters", [weth, newToken]),
  expect: expectNone,
});
cases.push({ label: "plain contract with no migration signature → ignored", address: await deployTimed(stranger, "Counter"), expect: expectNone });
cases.push({
  label: "thin market ($300 ok, $1,000 impact 7%): stored, Low-Cap passes, Strict fails",
  address: await deployTimed(stranger, "MigratorWithGetters", [thin, newToken]),
  expect: expectAlert((r) =>
    r.liquidity?.LOW_CAP.status !== "pass" || r.liquidity?.STRICT.status !== "skip" ? JSON.stringify(r.liquidity) : null),
});
cases.push({
  label: "OKX temporarily down (50001) → job retried, alert delivered",
  address: await deployTimed(stranger, "MigratorWithGetters", [flaky, newToken]),
  expect: expectAlert((r) => (r.liquidity?.STRICT.status !== "pass" ? JSON.stringify(r.liquidity) : null)),
});
cases.push({
  label: "RWA migrator (isin()/issuer()) from a registered custodian: alert despite no DEX market, tagged RWA",
  address: await deployTimed(custodian, "RwaMigrator", [illiquid, newToken]),
  expect: expectAlert((r) =>
    r.discovery !== "custodian" || r.custodianLabel !== "Test Custodian" || !r.rwaSignals.includes("isin()") || !r.rwaSignals.includes("issuer()")
      ? `discovery ${r.discovery}, rwa ${r.rwaSignals}` : null),
});
cases.push({
  label: "same RWA migrator from a non-custodian with no market → ignored",
  address: await deployTimed(stranger, "RwaMigrator", [illiquid, newToken]),
  expect: expectNone,
});

// CREATE2 via a factory, called by an untracked wallet: found through the block trace.
const factory = await deploy(stranger, "MigratorFactory");
const salt = ("0x" + "22".repeat(32)) as Hex;
const { abi: factoryAbi } = artifacts.MigratorFactory!;
const predicted = (await chain.simulateContract({ account: stranger.account, address: factory, abi: factoryAbi, functionName: "deploy", args: [oldTwin, newToken, salt] })).result as Address;
const t0 = Date.now();
await chain.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: factory, abi: factoryAbi, functionName: "deploy", args: [oldTwin, newToken, salt] } as never) });
sent.set(lower(predicted), t0);
cases.push({
  label: "CREATE2 child of a factory called by an untracked wallet (block trace)",
  address: predicted,
  expect: expectAlert((r) => (!eq(r.tokenAAddress, oldTwin) ? `A ${r.tokenAAddress}` : null)),
});

// --- wait & report ------------------------------------------------------------------------------
const expected = cases.filter((c) => c.expect(undefined) !== null).map((c) => lower(c.address));
const deadline = Date.now() + 45_000;
while (expected.some((a) => !alerts.has(a)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 4000)); // anything unexpected

console.log("\n=== auto-discovery ===");
for (const c of cases) {
  const a = alerts.get(lower(c.address));
  const problem = c.expect(a?.record);
  if (problem) failures++;
  const latency = a && sent.get(lower(c.address)) ? ` latency=${((a.at - sent.get(lower(c.address))!) / 1000).toFixed(1)}s` : "";
  console.log(`${problem ? "FAIL" : "ok  "} ${c.label}${a ? ` [${a.record.confidence} ${a.record.confidenceScore}%]${latency}` : ""}${problem ? "  <- " + problem : ""}`);
}

console.log("\n=== routing, caching, speed ===");
const thinRec = alerts.get(lower(cases[12]!.address))?.record;
const firstRec = alerts.get(lower(cases[0]!.address))?.record;
const rwaRec = alerts.get(lower(cases[14]!.address))?.record;
check("thin market: a Low-Cap chat gets it, a Strict chat doesn't", !!thinRec && wantsAutoAlert(lowCapChat, thinRec) && !wantsAutoAlert(strictChat, thinRec));
check("a chat with auto alerts off gets no auto alert", !!firstRec && !wantsAutoAlert(trackedOnlyChat, firstRec) && wantsAutoAlert(strictChat, firstRec));
check("custodian RWA alert reaches Strict chats without a DEX market", !!rwaRec && wantsAutoAlert(strictChat, rwaRec));
const trackedRec = alerts.get(lower(cases[2]!.address))?.record;
check("tracked-project alerts ignore the auto toggle and liquidity level", !!trackedRec && wantsAutoAlert(trackedOnlyChat, trackedRec));
const twinRequests = okxRequests.get(lower(oldTwin)) ?? 0;
check(`OKX results cached per token: OLD-twin used by 6 contracts, ${twinRequests} quote request(s) (≤ 2: $300 + $1,000)`, twinRequests <= 2 && twinRequests > 0, twinRequests);
check("every OKX request carried the signed OK-ACCESS-* headers", okxSignedOk);
const latencies = cases.flatMap((c) => {
  const a = alerts.get(lower(c.address));
  const s = sent.get(lower(c.address));
  return a && s ? [(a.at - s) / 1000] : [];
});
const slowest = Math.max(...latencies);
check(`deploy → alert ≤ 10s for every direct detection (slowest ${slowest.toFixed(1)}s)`, slowest <= 10, latencies);
const stats = autoStats(NETWORK);
check(
  `stats: ${stats?.creations} new contracts seen, ${stats?.candidates} candidates, ${stats?.liquiditySkipped} dropped by liquidity, ${stats?.alerts} auto alerts`,
  // 14 direct deploys by untracked wallets + the factory + its CREATE2 child
  !!stats && stats.creations >= 16 && stats.liquiditySkipped >= 2 && (stats.skipped["liquidity pool"] ?? 0) >= 1,
  stats,
);
const cardProblems = [...alerts.values()].flatMap(({ record }) =>
  (["en", "uk", "ru"] as const).flatMap((lang) => {
    const card = formatMigrationAlert(null, record, lang);
    const problem = markdownV2Problem(card) ?? (card.length > 4096 ? "too long" : null);
    return problem ? [`${lang} ${record.contractAddress}: ${problem}`] : [];
  }),
);
check(`all ${alerts.size} cards (auto, custodian, Unverified, tracked) are valid MarkdownV2 in 3 languages`, cardProblems.length === 0, cardProblems);
if (firstRec) console.log("\n=== SAMPLE AUTO CARD (uk) ===\n" + formatMigrationAlert(null, firstRec, "uk"));
if (rwaRec) console.log("\n=== SAMPLE CUSTODIAN CARD (en) ===\n" + formatMigrationAlert(null, rwaRec, "en"));

await stop();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
