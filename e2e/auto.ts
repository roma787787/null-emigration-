// Auto-discovery acceptance run (refactoring spec): the bot finds migrations
// among ALL new contracts — no /add_token — ties tokens strictly by address,
// drops pools / fee-swap tokens / base-asset pairs, filters by an OKX
// executable-route test (stubbed here), and handles CREATE2 factories, RWA
// custodians and ticker-only targets. Needs anvil on :8545 plus Postgres and
// Redis — see README "End-to-end test".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getContractAddress, http, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
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
process.env.RECHECK_DELAYS_SEC = "3,6,12";
process.env.AUTO_DISCOVERY = "true";
process.env.OKX_MIN_INTERVAL_MS = "20";
process.env.AUTO_TRACE_MODE = "block"; // the factory cases below hold the child's code themselves; "calldata" gets its own check
process.env.AUTO_DEDUP_HOURS = "0"; // many cases reuse the same tokens / code; dedup gets its own check below

// --- signature DB stub --------------------------------------------------------------
const KNOWN = [
  "migrate(uint256)", "oldToken()", "newToken()", "rate()", "token0()", "token1()",
  "swap(uint256,uint256,address,bytes)", "getReserves()", "swapTokensForEth(uint256)", "swapBack()",
  "pairedToken()", "newTokenSymbol()", "tokenIn()", "tokenOut()", "swapExactIn(uint256)", "swapTokens(uint256,uint256)",
  "execute(bytes)", "token()", "rewardToken()", "asset()", "totalAssets()", "convertToShares(uint256)",
  "convertToAssets(uint256)", "deposit(uint256,address)", "quoteToken()", "migratedPools(address)",
  "setMigratedPool(address,bool)", "setMigratedPools(address[],bool)", "swapAndLiquify(uint256)", "buyTokens()", "exchange(uint256)", "isin()", "issuer()", "LEND()", "AAVE()", "migrateFromLEND(uint256)",
  "LEND_AAVE_RATIO()", "REVISION()", "_totalLendMigrated()", "migrationStarted()", "initialize()",
  "initialize(address,address,bytes)", "upgradeTo(address)", "upgradeToAndCall(address,bytes)", "implementation()",
  "admin()", "changeAdmin(address)", "createPair(address,address)", "setTokens(address,address)", "totalSupply()", "balanceOf(address)", "transfer(address,uint256)",
  "name()", "symbol()", "decimals()", "deploy(address,address,bytes32)",
  "migrate(address)", "uniswapV3SwapCallback(int256,int256,bytes)", "UNDERLYING_ASSET_ADDRESS()",
  "migrate()", "startMigration()", "finalizeMigration()", "migrating()",
  "converter()", "convert(uint256)", "convertFromOld(uint256)", "tao()", "legacy()", "underlying()", "legacyToken()", "migrateLegacyMatic(uint256)", "migrateStake(address,uint256)", "stakingToken()",
  "newStaking()", "fromToken()", "toToken()", "convert(address,address,uint256)",
  "quickToQuickX(uint256)", "SWAP_RATIO()", "quick()", "quickX()", "closedForTest()",
  "convertir(uint256,address,bytes)", "convertirSousPlancher(uint256,address,bytes,uint256)", "phar()", "p33()",
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
type Impacts = { low: number; strict: number; deep?: number; dollar?: boolean; price?: number };
type Market = Impacts | "noroute" | { failFirst: number; then: Impacts };
const markets = new Map<string, Market>();
const okxRequests = new Map<string, number>();
const okxSells: string[] = [];
let okxSignedOk = true;
const okx = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const to = (url.searchParams.get("toTokenAddress") ?? "").toLowerCase();
  const from = (url.searchParams.get("fromTokenAddress") ?? "").toLowerCase();
  const amount = BigInt(url.searchParams.get("amount") ?? "0");
  okxRequests.set(to, (okxRequests.get(to) ?? 0) + 1);
  // A sale back into the test stable (the migration round trip): N tokens fetch N × price, less the $300 impact.
  if (to === lower(usd)) {
    const sold = markets.get(from);
    okxSells.push(from);
    if (!sold || typeof sold !== "object" || "failFirst" in sold || !sold.price) {
      return void res.end(JSON.stringify({ code: "82000", msg: "Insufficient liquidity" }));
    }
    const out = (amount * BigInt(Math.round(sold.price * 1e6))) / 1_000_000n * BigInt(Math.round((100 - sold.low) * 100)) / 10_000n;
    return void res.end(JSON.stringify({ code: "0", msg: "", data: [{ toTokenAmount: out.toString(), priceImpactPercent: String(-sold.low) }] }));
  }
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
  // $300 → low, $1,000 → strict, $10,000 → deep (default: 3× the $1,000 impact).
  const impact = amount >= 10000n * 10n ** 18n ? (market.deep ?? market.strict * 3) : amount >= 1000n * 10n ** 18n ? market.strict : market.low;
  // A dollar token: $N buys N of it (same raw amount: the test stable and the token both have 18 decimals).
  // A priced token: $N buys N / price of it (18 decimals on both sides).
  const toTokenAmount = market.dollar
    ? amount.toString()
    : market.price ? (amount * 1_000_000n / BigInt(Math.round(market.price * 1e6))).toString() : "1000";
  res.end(JSON.stringify({ code: "0", msg: "", data: [{ toTokenAmount, priceImpactPercent: String(-impact) }] }));
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
const spammer = wallet("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
// Genuine production bytecode from npm (see e2e/fetch-real-artifacts.cjs).
const real = JSON.parse(readFileSync(fileURLToPath(new URL("./real-artifacts.json", import.meta.url)), "utf8")) as Record<string, Artifact>;
async function deployReal(from: typeof owner, name: string, args: unknown[] = []) {
  const { abi, bytecode } = real[name]!;
  const hash = await from.deployContract({ abi, bytecode, args } as never);
  return (await chain.waitForTransactionReceipt({ hash })).contractAddress!;
}

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
{
  const { createRedisConnection } = await import("../src/queue/redisClient.js");
  const r = createRedisConnection();
  const stale = await r.keys("auto:seen:*");
  if (stale.length) await r.del(...stale);
  r.disconnect();
}
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
  const address = name.startsWith("__real__") ? await deployReal(from, name.slice(8), args) : await deploy(from, name, args);
  sent.set(lower(address), t0);
  return address;
}

// Chats with different settings, to check routing.
const chat = (liquidityLevel: "STRICT" | "LOW_CAP" | "DEEP", autoAlerts = true) =>
  ({ chatId: "c", liquidityLevel: liquidityLevel as "STRICT" | "LOW_CAP" | "DEEP", autoAlerts, confidenceFilter: "ALL", networksFilter: null, language: "en", approved: true, accessRequested: true, createdAt: new Date() }) as const;
const strictChat = chat("STRICT"), lowCapChat = chat("LOW_CAP"), deepChat = chat("DEEP"), trackedOnlyChat = chat("STRICT", false);

// History backfill (at the end) re-runs every block from here on.
const scanFrom = (await chain.getBlockNumber()) + 1n;

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

// --- real production contracts ---------------------------------------------------------------
const realLend = await token("EthLend", "LEND");
const realAave = await token("Aave Token", "AAVE");
markets.set(lower(realLend), { low: 0.1, strict: 0.4 });
markets.set(lower(realAave), "noroute"); // the new token has no market yet at migration time
const lendImpl = await deployTimed(stranger, "__real__LendToAaveMigrator", [realAave, realLend, 100n]);
cases.push({
  label: "REAL Aave LendToAaveMigrator (npm bytecode): A = LEND, B = AAVE, found without /add_token",
  address: lendImpl,
  expect: expectAlert((r) => (!eq(r.tokenAAddress, realLend) || !eq(r.tokenBAddress, realAave) ? `A ${r.tokenAAddress} B ${r.tokenBAddress}` : null)),
});
// Aave's own rollout: an empty InitializableAdminUpgradeabilityProxy first,
// pointed at the migrator by a later initialize() — caught on re-check.
const lendProxy = await deployTimed(stranger, "__real__InitializableAdminUpgradeabilityProxy");
const proxyAbi = real.InitializableAdminUpgradeabilityProxy!.abi;
await chain.waitForTransactionReceipt({
  hash: await stranger.writeContract({
    address: lendProxy, abi: proxyAbi, functionName: "initialize",
    args: [lendImpl, owner.account.address, toFunctionSelector("initialize()")],
  } as never),
});
cases.push({
  label: "REAL Aave proxy deployed empty, initialize()d later → found by re-check (A = LEND, B = AAVE)",
  address: lendProxy,
  expect: expectAlert((r) => (!eq(r.tokenAAddress, realLend) || !eq(r.tokenBAddress, realAave) ? `A ${r.tokenAAddress} B ${r.tokenBAddress}` : null)),
});
const uniFactory = await deployTimed(stranger, "__real__UniswapV2Factory", [stranger.account.address]);
cases.push({ label: "REAL UniswapV2Factory → ignored", address: uniFactory, expect: expectNone });
const pairAddress = (await chain.simulateContract({ account: stranger.account, address: uniFactory, abi: real.UniswapV2Factory!.abi, functionName: "createPair", args: [oldTwin, realLend] })).result as Address;
sent.set(lower(pairAddress), Date.now());
await chain.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: uniFactory, abi: real.UniswapV2Factory!.abi, functionName: "createPair", args: [oldTwin, realLend] } as never) });
cases.push({ label: "REAL UniswapV2Pair created via CREATE2 by the factory → ignored (a pool, both tokens liquid)", address: pairAddress, expect: expectNone });

// Tokens only inside the code (immutables read from a registry): the bytecode scan finds them.
const registry = await deploy(stranger, "TokenRegistry", [oldTwin, newToken2]);
cases.push({
  label: "tokens only as immutables in the bytecode (no getters, not in ctor args) → found from the code",
  address: await deployTimed(stranger, "HardcodedMigrator", [registry]),
  expect: expectAlert((r) => (!eq(r.tokenAAddress, oldTwin) || !eq(r.tokenBAddress, newToken2) || r.tokenBSource !== "bytecode" ? `A ${r.tokenAAddress} B ${r.tokenBAddress} via ${r.tokenBSource}` : null)),
});
// Both tokens hard-coded (no names) and BOTH trade, the new one deeper — Telcoin's
// TEL → TEL v3 on Base, where the new token was listed before the migration opened.
// The market can't tell old from new; the one deployed first is the old one.
const telOld = await token("Telcoin", "TEL");
const telNew = await token("Telcoin", "TEL");
markets.set(lower(telOld), { low: 0.55, strict: 0.87, deep: 4.7 });
markets.set(lower(telNew), { low: 0.1, strict: 0.3, deep: 1.2 });
const telRegistry = await deploy(stranger, "TokenRegistry", [telNew, telOld]);
cases.push({
  label: "hard-coded tokens that both trade, the new one deeper (TEL → TEL v3) → Token A is the one deployed first",
  address: await deployTimed(stranger, "HardcodedMigrator", [telRegistry]),
  expect: expectAlert((r) => (!eq(r.tokenAAddress, telOld) || !eq(r.tokenBAddress, telNew) ? `A ${r.tokenAAddress} B ${r.tokenBAddress}` : null)),
});
// Deployed empty, tokens set by a later tx: re-check picks it up.
const late = await deployTimed(stranger, "LateConfiguredMigrator");
await chain.waitForTransactionReceipt({
  hash: await stranger.writeContract({ address: late, abi: artifacts.LateConfiguredMigrator!.abi, functionName: "setTokens", args: [oldTwin, newToken] } as never),
});
cases.push({
  label: "migrator deployed empty, setTokens() called later → found by re-check",
  address: late,
  expect: expectAlert((r) => (!eq(r.tokenAAddress, oldTwin) || !eq(r.tokenBAddress, newToken) ? `A ${r.tokenAAddress} B ${r.tokenBAddress}` : null)),
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

// A custodian registered by its FACTORY contract (Dinari's DShareFactory shape): whoever
// calls it, what it creates is the custodian's — and skips the DEX test.
const custodianFactory = await deploy(stranger, "MigratorFactory");
await custodianRepository.upsert(NETWORK, custodianFactory, "Factory Custodian");
const salt2 = ("0x" + "33".repeat(32)) as Hex;
const viaCustodianFactory = (await chain.simulateContract({ account: stranger.account, address: custodianFactory, abi: factoryAbi, functionName: "deploy", args: [illiquid, newToken, salt2] })).result as Address;
sent.set(lower(viaCustodianFactory), Date.now());
await chain.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: custodianFactory, abi: factoryAbi, functionName: "deploy", args: [illiquid, newToken, salt2] } as never) });
cases.push({
  label: "custodian registered by its factory contract (Dinari DShareFactory shape): child alerted as custodian",
  address: viaCustodianFactory,
  expect: expectAlert((r) => (r.discovery !== "custodian" || r.custodianLabel !== "Factory Custodian" ? `discovery ${r.discovery} ${r.custodianLabel}` : null)),
});

// Shapes that flooded the first production run: swap bots, zaps / presales, and
// "migrators" with no target token. Both of their tokens have real markets here.
cases.push({
  label: "swap bot (tokenIn/tokenOut + swap functions, two liquid tokens) → ignored",
  address: await deployTimed(stranger, "SwapBot", [oldTwin, realLend]),
  expect: expectNone,
});
cases.push({
  label: "zap / presale (swapAndLiquify, buyTokens, exchange; liquid token) → ignored",
  address: await deployTimed(stranger, "ZapPresale", [oldTwin, realLend]),
  expect: expectNone,
});
cases.push({
  label: "swap bot buying a FRESH token (no market) — only the signature gate can stop it → ignored",
  address: await deployTimed(stranger, "SwapBot", [oldTwin, newToken2]),
  expect: expectNone,
});
cases.push({
  label: "bare swap(uint256) between two TRADED tokens (bot shape) → ignored",
  address: await deployTimed(stranger, "MigratorPrivate", [realLend, oldTwin]),
  expect: expectNone,
});
// The first real false positives from production (ERC-4626 vaults, a four.meme-style token).
cases.push({ label: "ERC-4626 vault over a liquid asset (gtWETH / USDG vault shape) → ignored", address: await deployTimed(stranger, "Erc4626LikeVault", [realLend]), expect: expectNone });
cases.push({ label: "ERC-4626 vault that also has migrate(uint256) (MATIC vault shape) → ignored", address: await deployTimed(stranger, "VaultWithMigrate", [realLend]), expect: expectNone });
cases.push({
  label: "migrator whose new token is an ERC-4626 vault share (PHAR → p33, SHADOW → x33: a deposit) → ignored",
  address: await deployTimed(stranger, "MigratorWithGetters", [realLend, await deploy(owner, "Erc4626LikeVault", [realLend])]),
  expect: expectNone,
});
cases.push({ label: "meme token with setMigratedPool / migratedPools (four.meme shape) → ignored", address: await deployTimed(stranger, "MemePoolToken", [realLend]), expect: expectNone });
// Ethereum backfill, 7 days: 12 would-be alerts, most of them these shapes.
cases.push({
  label: "wrapper token with a converter() getter over a traded token (Ondo TSLAon, UNI, CULT wrappers) → ignored",
  address: await deployTimed(stranger, "WrapperWithConverter", [oldTwin, realLend]),
  expect: expectNone,
});
cases.push({
  label: "new token with a bare convert() over a traded token (wTAO → subnet-style tokens) → ignored",
  address: await deployTimed(stranger, "ConvertMintToken", [oldTwin]),
  expect: expectNone,
});
cases.push({
  label: "new token with convertFromOld() over its old token → alert (the token itself is Token B)",
  address: await deployTimed(stranger, "ConvertFromOldToken", [oldToken]),
  expect: expectAlert((r) => (!eq(r.tokenAAddress, oldToken) || r.tokenBSource !== "contract_itself" ? `A ${r.tokenAAddress} B ${r.tokenBAddress} via ${r.tokenBSource}` : null)),
});
cases.push({
  label: "share token with migrate() + convertToShares/convertToAssets but no asset() (the MATIC vault) → ignored",
  address: await deployTimed(stranger, "ShareTokenWithMigrate", [oldTwin]),
  expect: expectNone,
});
cases.push({
  label: "staking contract moving stakes, migrateStake(address,uint256) (EARN) → ignored",
  address: await deployTimed(stranger, "StakeMigrator", [oldTwin, newToken2]),
  expect: expectNone,
});
const rlusd = await token("Ripple USD", "RLUSD");
const pyusd = await token("PayPal USD", "PYUSD");
markets.set(lower(rlusd), { low: 0.01, strict: 0.01, deep: 0.02, dollar: true });
markets.set(lower(pyusd), { low: 0.01, strict: 0.01, deep: 0.02, dollar: true });
cases.push({
  label: "converter between two dollar tokens, convert(address,address,uint256) (RLUSD → PYUSD, crvUSD ↔ reUSD) → ignored",
  address: await deployTimed(stranger, "StableConverter", [rlusd, pyusd]),
  expect: expectNone,
});

// BSC cards (BNC4 / NVDAB / QQQB / FXIon…): launchpad tokens whose quote token trades.
cases.push({
  label: "launchpad token with pool-graduation settings AND a function named migrate() → ignored",
  address: await deployTimed(stranger, "LaunchpadTokenWithMigrate", [realLend]),
  expect: expectNone,
});
cases.push({
  label: "launch token with startMigration() / finalizeMigration() phases → ignored",
  address: await deployTimed(stranger, "PhasedLaunchToken", [realLend]),
  expect: expectNone,
});
// Production false positives on Optimism / Base: a bot with migrate(address) +
// uniswapV3SwapCallback, and Aave's aWETH as "Token A".
cases.push({
  label: "bot with migrate(address) + uniswapV3SwapCallback, tokens in its code (Optimism/Base 0x067f… shape) → ignored",
  address: await deployTimed(stranger, "CallbackBotMigrate", [oldTwin, newToken2]),
  expect: expectNone,
});
const aWeth = await deploy(owner, "ATokenLike", [weth]);
markets.set(lower(aWeth), { low: 0.05, strict: 0.05, deep: 0.06 });
cases.push({
  label: "'migration' out of Aave aWETH (a wrapper of a base asset) → ignored",
  address: await deployTimed(stranger, "MigratorWithGetters", [aWeth, newToken2]),
  expect: expectNone,
});
cases.push({
  label: "migrate() + oldToken() but no target token → not alerted (re-checked later)",
  address: await deployTimed(stranger, "MigratorNoTarget", [oldTwin]),
  expect: expectNone,
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
const aaveRec = alerts.get(lower(lendImpl))?.record;
check(
  "Deep ($10,000 / ≤3%): a deep market passes (LEND 1.2%), a mid one doesn't (OLD-twin 3.3%) — Strict takes both",
  !!aaveRec && !!firstRec && wantsAutoAlert(deepChat, aaveRec) && !wantsAutoAlert(deepChat, firstRec) && wantsAutoAlert(strictChat, firstRec),
  { aave: aaveRec?.liquidity?.DEEP, twin: firstRec?.liquidity?.DEEP },
);
check("a chat with auto alerts off gets no auto alert", !!firstRec && !wantsAutoAlert(trackedOnlyChat, firstRec) && wantsAutoAlert(strictChat, firstRec));
check("custodian RWA alert reaches Strict chats without a DEX market", !!rwaRec && wantsAutoAlert(strictChat, rwaRec));
const trackedRec = alerts.get(lower(cases[2]!.address))?.record;
check("tracked-project alerts ignore the auto toggle and liquidity level", !!trackedRec && wantsAutoAlert(trackedOnlyChat, trackedRec));
const twinRequests = okxRequests.get(lower(oldTwin)) ?? 0;
check(`OKX results cached per token: OLD-twin used by 6 contracts, ${twinRequests} quote request(s) (≤ 4: $300 + $1,000 + $10,000 + the $20 price quote)`, twinRequests <= 4 && twinRequests > 0, twinRequests);
check("every OKX request carried the signed OK-ACCESS-* headers", okxSignedOk);
const viaRecheck = new Set([lower(lendProxy), lower(late)]); // found on re-check by design, seconds later
const latencies = cases.filter((c) => !viaRecheck.has(lower(c.address))).flatMap((c) => {
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

// --- migration terms & "migration opened" -------------------------------------------------------
console.log("\n=== migration terms & opening ===");
{
  const { pollOpenings } = await import("../src/chain/migrationOpenWatcher.js");
  const { formatMigrationOpened, termsLines } = await import("../src/telegram/notificationFormatter.js");
  const nowSec = BigInt((await chain.getBlock()).timestamp);
  const oldA = await token("Legacy A", "LEGA");
  const newA = await token("Fresh A", "FRSA");
  const oldB = await token("Legacy B", "LEGB");
  const newB = await token("Fresh B", "FRSB");
  markets.set(lower(oldA), { low: 0.3, strict: 0.9, price: 0.0021 });
  // The new token trades, but thinly: even the small price quote moves it 12%.
  markets.set(lower(newA), { low: 12, strict: 25, price: 0.0022 });
  markets.set(lower(oldB), { low: 0.3, strict: 0.9, price: 1.5 });
  markets.set(lower(newB), "noroute");
  // Not open yet: starts in a day.
  const pending = await deployTimed(stranger, "TimedMigrator", [oldA, newA, nowSec + 86_400n, nowSec + 30n * 86_400n]);
  // Open, and funded before it is even deployed (its address is known in advance).
  const nonce = await chain.getTransactionCount({ address: stranger.account.address });
  const openAddress = getContractAddress({ from: stranger.account.address, nonce: BigInt(nonce) });
  const tokenAbi = artifacts.SimpleToken!.abi;
  await chain.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: newB, abi: tokenAbi, functionName: "transfer", args: [openAddress, 10n ** 24n] } as never),
  });
  const open = await deployTimed(stranger, "TimedMigrator", [oldB, newB, nowSec - 60n, nowSec + 30n * 86_400n]);
  const until = Date.now() + 30_000;
  while ((!alerts.has(lower(pending)) || !alerts.has(lower(open))) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  const pendingTerms = alerts.get(lower(pending))?.record.terms;
  const openTerms = alerts.get(lower(open))?.record.terms;
  check(
    "terms: a migrator that starts tomorrow is 'not open yet' with its start and deadline from the contract",
    pendingTerms?.status === "not_started" && pendingTerms.startsAt === Number(nowSec + 86_400n) && pendingTerms.endsAt === Number(nowSec + 30n * 86_400n),
    pendingTerms,
  );
  const spread = pendingTerms?.prices?.spreadPercent ?? NaN;
  check(
    `terms: both tokens priced from the OKX quotes (old $0.0021, new $0.0022 on a thin market → spread ${spread.toFixed(2)}% at 1:1)`,
    Math.abs((pendingTerms?.prices?.oldUsd ?? 0) - 0.0021) < 1e-6 && Math.abs((pendingTerms?.prices?.newUsd ?? 0) - 0.0022) < 1e-6 &&
      Math.abs(spread - 4.76) < 0.05 && pendingTerms?.prices?.newThin === true && !pendingTerms.prices.oldThin,
    pendingTerms?.prices,
  );
  const trip = pendingTerms?.prices?.roundTrip;
  check(
    `terms: the trade quoted both ways — $300 of the old token, migrated 1:1, sold on the thin market → $${trip?.outUsd} (${trip?.percent?.toFixed(1)}%)`,
    trip?.inUsd === 300 && Math.abs((trip.outUsd ?? 0) - 276.57) < 0.02 && Math.abs((trip.percent ?? 0) + 7.81) < 0.02 && okxSells.includes(lower(newA)),
    trip,
  );
  check(
    "terms: an unfunded migrator shows 0 new tokens on the contract",
    pendingTerms?.funding?.kind === "balance" && pendingTerms.funding.empty,
    pendingTerms?.funding,
  );
  check(
    "terms: an open migrator funded with 1,000,000 new tokens says so; a new token without a market has no price",
    openTerms?.status === "open" && openTerms.funding?.kind === "balance" && openTerms.funding.amount === "1,000,000" &&
      openTerms.funding.symbol === "FRSB" && openTerms.prices?.oldUsd === 1.5 && openTerms.prices.newUsd === null && openTerms.prices.spreadPercent === null,
    openTerms,
  );
  const pendingRec = alerts.get(lower(pending))?.record;
  const cardEn = pendingRec ? formatMigrationAlert(null, pendingRec, "en") : "";
  check(
    "the card shows the status, deadline, prices and the trade result instead of the bare spread (valid MarkdownV2)",
    /Status: opens \d\d\\\.\d\d\\\.\d{4}/.test(cardEn) && /Deadline/.test(cardEn) && /old \$0\\\.002100 · new \$0\\\.002200 \\\(thin market\\\)/.test(cardEn) &&
      !/spread/.test(cardEn) && /🔄 .*\$300.*\$276\\\.5\d \\\(−7\\\.8%\\\)/.test(cardEn) && !markdownV2Problem(cardEn),
    cardEn,
  );

  // Someone migrates through the open one.
  const migratorAbi = artifacts.TimedMigrator!.abi;
  await chain.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: oldB, abi: tokenAbi, functionName: "approve", args: [open, 10n ** 21n] } as never),
  });
  const migrateTx = await owner.writeContract({ address: open, abi: migratorAbi, functionName: "migrate", args: [10n ** 21n] } as never);
  await chain.waitForTransactionReceipt({ hash: migrateTx });
  const opened: NonNullable<Record_>[] = [];
  await pollOpenings(NETWORK, async (record) => void opened.push(record), { chunk: 500, maxChunks: 100 });
  const openedOpen = opened.find((r) => eq(r.contractAddress, open));
  check(
    "migration opened: the first exchange through the contract is found, with its transaction",
    !!openedOpen && eq(openedOpen.openedTx, migrateTx) && !opened.some((r) => eq(r.contractAddress, pending)),
    opened.map((r) => ({ contract: r.contractAddress, tx: r.openedTx })),
  );
  const again: unknown[] = [];
  await pollOpenings(NETWORK, async (record) => void again.push(record), { chunk: 500, maxChunks: 100 });
  check("…and announced once: the next pass finds nothing new", again.length === 0, again);
  // A detection from before the watch existed (no terms) is never watched — no "opened" for old news.
  await pool.query(`UPDATE migration_contracts SET opened_at = NULL, opened_tx = NULL, open_cursor = NULL, terms = NULL WHERE contract_address = lower($1)`, [open]);
  const legacy: unknown[] = [];
  await pollOpenings(NETWORK, async (record) => void legacy.push(record), { chunk: 500, maxChunks: 100 });
  check("a detection without terms (from before the watch) is not watched", legacy.length === 0, legacy);
  const openedCard = openedOpen ? formatMigrationOpened(openedOpen, "ru") : "";
  check(
    "the 'migration opened' card names the transaction and the prices (valid MarkdownV2)",
    /МИГРАЦИЯ ОТКРЫЛАСЬ/.test(openedCard) && openedCard.includes(migrateTx.slice(0, 6)) && /старый \$1\\\.50/.test(openedCard) && !markdownV2Problem(openedCard),
    openedCard,
  );
  if (openedOpen) console.log("\n=== SAMPLE 'MIGRATION OPENED' CARD (ru) ===\n" + openedCard);
  check(
    "rate: a migrator that opens tomorrow is simulated at its start time — 1:1",
    pendingTerms?.rate?.newPerOld === 1 && pendingTerms.rate.source === "simulated",
    pendingTerms?.rate,
  );

  // The rate: never 1:1 by default. QUICK-style SWAP_RATIO() = 750 (new per old),
  // a 1:1000 redenomination with no rate getter at all.
  const { termsFor } = await import("../src/analyzer/migrationTerms.js");
  const oldQ = await token("QuickSwap Old", "QUICK");
  const newQ = await token("QuickSwap New", "QUICKX");
  markets.set(lower(oldQ), { low: 0.5, strict: 1, price: 12.25 });
  markets.set(lower(newQ), { low: 2, strict: 5, price: 0.01064 });
  const quickOpen = await deploy(stranger, "QuickStyleConverter", [oldQ, newQ, false]);
  const quickClosed = await deploy(stranger, "QuickStyleConverter", [oldQ, newQ, true]);
  const oldH = await token("Redenominated Old", "REDO");
  const newH = await token("Redenominated New", "REDN");
  markets.set(lower(oldH), { low: 0.3, strict: 0.6, price: 1 });
  markets.set(lower(newH), { low: 1, strict: 2, price: 0.00105 });
  const hidden = await deploy(stranger, "HiddenRateMigrator", [oldH, newH]);

  const quickTerms = await termsFor(NETWORK, quickOpen, oldQ, newQ);
  const quickTrip = quickTerms?.prices?.roundTrip;
  check(
    `rate: SWAP_RATIO() = 750 confirmed by a trial exchange on the unfunded converter → 1:750, $300 → $${quickTrip?.outUsd} (not $0.26 at 1:1)`,
    quickTerms?.rate?.source === "simulated" && quickTerms.rate.newPerOld === 750 &&
      Math.abs((quickTrip?.outUsd ?? 0) - 191.52) < 0.05 && Math.abs((quickTerms.prices?.spreadPercent ?? 0) - -34.85) < 0.05,
    quickTerms,
  );
  const quickCard = termsLines("ru", quickTerms).join("\n");
  check(
    "rate: the card says 1:750, checked by a trial exchange, and trades at it",
    /🔁 Курс \\\(старый:новый\\\): 1:750 — проверено пробным обменом/.test(quickCard) && /мигрировать 1:750 → продать новый/.test(quickCard) && !markdownV2Problem(quickCard),
    quickCard,
  );
  const closedTerms = await termsFor(NETWORK, quickClosed, oldQ, newQ);
  check(
    "rate: no exchange possible → SWAP_RATIO() = 750 read as × 750, the reading prices agree with",
    closedTerms?.rate?.source === "ratio" && closedTerms.rate.newPerOld === 750 && closedTerms.rate.checked === true &&
      Math.abs((closedTerms.prices?.roundTrip?.outUsd ?? 0) - 191.52) < 0.05,
    closedTerms,
  );
  const hiddenTerms = await termsFor(NETWORK, hidden, oldH, newH);
  check(
    `rate: a 1:1000 redenomination with no rate getter is found by the trial exchange ($300 → $${hiddenTerms?.prices?.roundTrip?.outUsd})`,
    hiddenTerms?.rate?.source === "simulated" && hiddenTerms.rate.newPerOld === 1000 && hiddenTerms.ratio === null &&
      Math.abs((hiddenTerms.prices?.roundTrip?.outUsd ?? 0) - 311.85) < 0.05,
    hiddenTerms,
  );
  // PHAR → p33 (Avalanche): convertir(amount, to, data) at 0.64, prices 1.56× apart. At 1:1 it read +52.7%.
  const phar = await token("Pharaoh", "PHAR");
  const p33 = await token("p33", "p33");
  markets.set(lower(phar), { low: 0.3, strict: 1.7, price: 0.1042 });
  markets.set(lower(p33), { low: 1, strict: 2, price: 0.1622 });
  const zap = await deploy(stranger, "ZapConverterFr", [phar, p33]);
  const zapTerms = await termsFor(NETWORK, zap, phar, p33);
  const zapTrip = zapTerms?.prices?.roundTrip;
  check(
    `rate: convertir(uint256,address,bytes) is tried with a recipient and empty data → 1:0.64, $300 → $${zapTrip?.outUsd} (${zapTrip?.percent?.toFixed(1)}%), not +52.7% at 1:1`,
    zapTerms?.rate?.source === "simulated" && Math.abs(zapTerms.rate.newPerOld - 0.64) < 1e-9 &&
      Math.abs((zapTrip?.outUsd ?? 0) - 295.88) < 0.05 && /1:0\\\.64 — checked by a trial exchange/.test(termsLines("en", zapTerms).join("\n")),
    zapTerms,
  );
  console.log("\n=== SAMPLE QUICK-STYLE TERMS (ru) ===\n" + quickCard);
}

// --- load: one block with 150 new contracts, one of them a migration ---------------------------
console.log("\n=== load: 151 contracts in one block ===");
const anvilRpc = (method: string, params: unknown[] = []) => chain.request({ method, params } as never);
await anvilRpc("evm_setBlockGasLimit", ["0x1dcd6500"]); // 500M: room for 151 deployments
await anvilRpc("evm_setIntervalMining", [0]);
await anvilRpc("evm_setAutomine", [false]);
const spamKinds: Array<[string, unknown[]]> = [["Counter", []], ["FakePair", [oldTwin, newToken]], ["FeeToken", [oldTwin]], ["SimpleToken", ["Spam", "SPAM", 1n]]];
let nonce = await chain.getTransactionCount({ address: spammer.account.address, blockTag: "pending" });
const spamAddresses: string[] = [];
for (let i = 0; i < 150; i++) {
  const [name, args] = spamKinds[i % spamKinds.length]!;
  const { abi, bytecode } = artifacts[name]!;
  await spammer.deployContract({ abi, bytecode, args, nonce, gas: 3_000_000n } as never);
  spamAddresses.push(lower(getContractAddress({ from: spammer.account.address, nonce: BigInt(nonce) })));
  nonce++;
}
const { abi: mAbi, bytecode: mCode } = artifacts.MigratorWithGetters!;
const loadMigratorHash = await stranger.deployContract({ abi: mAbi, bytecode: mCode, args: [oldTwin, newToken], gas: 3_000_000n } as never);
await anvilRpc("evm_mine");
const minedAt = Date.now();
await anvilRpc("evm_setAutomine", [true]);
await anvilRpc("evm_setIntervalMining", [1]);
const loadReceipt = await chain.waitForTransactionReceipt({ hash: loadMigratorHash });
const loadBlock = await chain.getBlock({ blockNumber: loadReceipt.blockNumber });
const loadMigrator = lower(loadReceipt.contractAddress!);
while (!alerts.has(loadMigrator) && Date.now() - minedAt < 30_000) await new Promise((r) => setTimeout(r, 100));
const loadLatency = alerts.has(loadMigrator) ? (alerts.get(loadMigrator)!.at - minedAt) / 1000 : Infinity;
await new Promise((r) => setTimeout(r, 5000));
const spamAlerts = spamAddresses.filter((a) => alerts.has(a)).length;
check(`the block really holds ${loadBlock.transactions.length} deployments`, loadBlock.transactions.length >= 151, loadBlock.transactions.length);
check(`the migration among them alerted ${loadLatency.toFixed(1)}s after the block was mined (≤ 10s)`, loadLatency <= 10, loadLatency);
check(`spam filtered: ${spamAlerts} alerts out of 150 spam contracts (pools, fee tokens, plain tokens, counters)`, spamAlerts === 0, spamAlerts);

// --- "calldata" trace mode (the production default): only calls shipping creation code are traced
process.env.AUTO_TRACE_MODE = "calldata";
const bytecodeDeployer = await deploy(stranger, "BytecodeDeployer");
const { abi: bdAbi } = artifacts.BytecodeDeployer!;
const { encodeDeployData } = await import("viem");
const childCode = encodeDeployData({ abi: artifacts.MigratorWithGetters!.abi, bytecode: artifacts.MigratorWithGetters!.bytecode, args: [realLend, newToken2] } as never);
const childSalt = ("0x" + "44".repeat(32)) as Hex;
const childAddress = (await chain.simulateContract({ account: stranger.account, address: bytecodeDeployer, abi: bdAbi, functionName: "deploy", args: [childCode, childSalt] })).result as Address;
const calldataT0 = Date.now();
await chain.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: bytecodeDeployer, abi: bdAbi, functionName: "deploy", args: [childCode, childSalt] } as never) });
const calldataUntil = Date.now() + 20_000;
while (!alerts.has(lower(childAddress)) && Date.now() < calldataUntil) await new Promise((r) => setTimeout(r, 200));
check(
  `"calldata" trace mode: CREATE2 via a deployer that receives the code in calldata is found (${alerts.has(lower(childAddress)) ? ((alerts.get(lower(childAddress))!.at - calldataT0) / 1000).toFixed(1) + "s" : "never"}) — no block trace`,
  alerts.has(lower(childAddress)) && eq(alerts.get(lower(childAddress))!.record.tokenAAddress, realLend),
);
// A custodian's factory holds the token code itself (nothing in calldata to spot): its calls are traced anyway.
const calldataCustodianFactory = await deploy(stranger, "MigratorFactory");
await custodianRepository.upsert(NETWORK, calldataCustodianFactory, "Calldata Custodian");
await new Promise((r) => setTimeout(r, 500));
const saltC = ("0x" + "66".repeat(32)) as Hex;
const custodianChild = (await chain.simulateContract({ account: stranger.account, address: calldataCustodianFactory, abi: factoryAbi, functionName: "deploy", args: [illiquid, newToken, saltC] })).result as Address;
const custodianT0 = Date.now();
await chain.waitForTransactionReceipt({ hash: await stranger.writeContract({ address: calldataCustodianFactory, abi: factoryAbi, functionName: "deploy", args: [illiquid, newToken, saltC] } as never) });
const custodianUntil = Date.now() + 20_000;
while (!alerts.has(lower(custodianChild)) && Date.now() < custodianUntil) await new Promise((r) => setTimeout(r, 200));
check(
  `"calldata" trace mode: a call into a registered custodian factory (no code in calldata) is traced (${alerts.has(lower(custodianChild)) ? ((alerts.get(lower(custodianChild))!.at - custodianT0) / 1000).toFixed(1) + "s" : "never"})`,
  alerts.get(lower(custodianChild))?.record.custodianLabel === "Calldata Custodian",
);
process.env.AUTO_TRACE_MODE = "block";

// --- dedup: the same migrator redeployed (same pair, same code) alerts once --------------------
process.env.AUTO_DEDUP_HOURS = "24";
// A clone with no market first: dropped by OKX, it must NOT count as "already alerted" for the code.
const liquiditySkipsBefore = autoStats(NETWORK)?.liquiditySkipped ?? 0;
const noMarketClone = lower(await deploy(stranger, "MigratorWithGetters", [illiquid, newToken2]));
const noMarketUntil = Date.now() + 20_000;
while ((autoStats(NETWORK)?.liquiditySkipped ?? 0) === liquiditySkipsBefore && Date.now() < noMarketUntil) await new Promise((r) => setTimeout(r, 200));
const dupFirst = lower(await deploy(stranger, "MigratorWithGetters", [oldTwin, newToken2]));
const dupSecond = lower(await deploy(stranger, "MigratorWithGetters", [oldTwin, newToken2]));
const dupUntil = Date.now() + 20_000;
while (!alerts.has(dupFirst) && Date.now() < dupUntil) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 4000));
check("dedup: a redeploy of the same migrator (same tokens, same code) alerts only once", alerts.has(dupFirst) && !alerts.has(dupSecond), {
  first: alerts.has(dupFirst),
  second: alerts.has(dupSecond),
});
check(
  "dedup: an earlier clone dropped for having no market doesn't block the next one (same code, token with a market)",
  !alerts.has(noMarketClone) && alerts.has(dupFirst),
  { noMarketClone: alerts.has(noMarketClone), next: alerts.has(dupFirst) },
);

// --- history backfill: every block of this test through the same pipeline, no alerts sent ----
{
  const { runBackfill, backfillCsv, decisionCounts } = await import("../src/backfill/backfill.js");
  const { formatBackfillSummary } = await import("../src/telegram/commands/backfill.js");
  const statsBefore = JSON.stringify(autoStats(NETWORK));
  const alertsBefore = alerts.size;
  const toBlock = await chain.getBlockNumber();
  const total = Number(toBlock - scanFrom + 1n);
  const t0 = Date.now();
  let progressCalls = 0;
  const report = await runBackfill({ network: NETWORK, fromBlock: scanFrom, toBlock, blocksPerSec: 1000, parallelBlocks: 16, concurrency: 8, onProgress: () => void progressCalls++ });
  const byAddress = new Map(report.candidates.map((c) => [lower(c.contractAddress), c]));
  const counts = decisionCounts(report);
  check(
    `backfill: ${report.blocksScanned}/${total} blocks, ${report.contracts} new contracts, ${report.candidates.length} candidates in ${((Date.now() - t0) / 1000).toFixed(1)}s (${JSON.stringify(counts)})`,
    report.blocksScanned === total && report.blocksFailed === 0 && report.analysisErrors === 0 && report.contracts >= 180 && progressCalls === 3,
    { scanned: report.blocksScanned, failed: report.blocksFailed, errors: report.analysisErrors, contracts: report.contracts, progressCalls },
  );
  const firstCase = cases[0]!;
  check(
    "backfill finds what went live: the first untracked migrator is an alert with the same Token A",
    byAddress.get(lower(firstCase.address))?.decision === "alert" && eq(byAddress.get(lower(firstCase.address))?.tokenAAddress, oldTwin),
    byAddress.get(lower(firstCase.address)),
  );
  const liveAuto = [...alerts.entries()].filter(([, a]) => !a.tracked).map(([address]) => address);
  const missing = liveAuto.filter((address) => !byAddress.has(address));
  check(`every one of the ${liveAuto.length} live auto alerts is a backfill candidate too`, missing.length === 0, missing);
  const spamFound = spamAddresses.filter((a) => byAddress.has(lower(a)));
  check("backfill drops the 150 spam contracts of the load block as well", spamFound.length === 0, spamFound);
  check(
    "backfill sends nothing and leaves the live /status counters alone",
    alerts.size === alertsBefore && JSON.stringify(autoStats(NETWORK)) === statsBefore,
    { alerts: alerts.size - alertsBefore },
  );
  const serial = await runBackfill({ network: NETWORK, fromBlock: scanFrom, toBlock, blocksPerSec: 1000, parallelBlocks: 1, concurrency: 1 });
  const decisions = (r: typeof report) => r.candidates.map((c) => `${c.blockNumber}:${lower(c.contractAddress)}:${c.decision}:${c.duplicateOf ?? ""}`).join("\n");
  check(
    "backfill 16 blocks at a time decides exactly as one block at a time (same candidates, order, duplicates)",
    decisions(serial) === decisions(report) && JSON.stringify(serial.skipped) === JSON.stringify(report.skipped),
    { serial: decisionCounts(serial), parallel: counts },
  );
  const csv = backfillCsv(report);
  const summary = formatBackfillSummary("ru", report);
  check(
    "backfill report: CSV with a row per candidate, summary lists the would-be alerts",
    csv.trim().split("\n").length === report.candidates.length + 1 && csv.startsWith("block,decision,contract") &&
      /Был бы алерт: \d+/.test(summary) && summary.toLowerCase().includes(lower(firstCase.address)),
    summary,
  );
}

await stop();
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
