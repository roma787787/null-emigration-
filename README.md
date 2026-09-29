# Multi-EVM Token Migration Tracker

Real-time monitor for EVM networks that scans every newly created contract
for token-migration mechanisms (auto-discovery), keeps only those whose old
token has a real DEX market (OKX executable-route test), and pushes alert
cards to Telegram. Wallets of projects added with `/add_token` get priority
alerts on top of that.

Implements the architecture from the project spec:

1. **Token & Owner DB** — tracked "Token A" contracts plus their discovered
   deployer / `owner()` / `admin()` / `DEFAULT_ADMIN_ROLE` addresses, plus any
   manually-linked wallets (`/add_owner`).
2. **Multi-EVM block listener** — subscribes to new blocks (WebSocket push
   when available, HTTP polling otherwise) on every configured network and
   flags contract-creation transactions from tracked owners, including ones
   deployed through a factory. Progress is saved per network, so after a
   restart or redeploy the listener first replays the blocks it missed.
3. **Migration analyzer** — reads the contract's function list from its
   bytecode (following EIP-1967 / beacon / EIP-1167 proxies to the
   implementation), names those functions via the public 4-byte signature
   database, and classifies them: `migrate*`, `convert*`, `swap*`,
   `exchange*` and `xxxToYyy` (e.g. `mkrToSky`) are strong signals;
   `claim`/`redeem`/`deposit` are weak and ignored when the contract is
   itself an ERC-20. Token B is found via known getters, then by calling
   every zero-argument function and keeping ERC-20 results other than Token
   A (catches `AAVE()`, `polygonEcosystemToken()`…), then via constructor
   args. Result: a HIGH / MEDIUM / LOW label plus a 0–100% score. A
   contract detected without Token B is re-checked later (proxies are often
   initialized with the tokens a few transactions after the deploy) and an
   update card is sent once Token B shows up.
4. **Telegram bot** — `/add_token`, `/list`, `/remove_token`, `/add_owner`,
   `/remove_owner`, `/settings`, `/analyze`, the admin-only `/status`, and
   the alert card itself. Every chat picks
   a language (English/Ukrainian/Russian) on first contact and needs
   administrator approval before any command works.

## Stack

TypeScript (Node.js) + [viem](https://viem.sh) + PostgreSQL + Redis
([BullMQ](https://docs.bullmq.io)) + [Telegraf](https://telegraf.js.org).

## Supported networks

Built in: Ethereum, BNB Smart Chain, Arbitrum One, Base, Optimism, Polygon,
Avalanche, Linea, Scroll, Blast, Polygon zkEVM, HyperEVM, Robinhood Chain (see
`src/config/networks.ts`). Keys for `ENABLED_NETWORKS`: `ethereum, bsc,
arbitrum, base, optimism, polygon, avalanche, linea, scroll, blast,
polygon-zkevm, hyperevm, robinhood`.

### Adding any other EVM network (no code change)

Declare it with environment variables — e.g. for Sonic:

```
EXTRA_NETWORKS=sonic                          # comma-separated, lowercase keys
NETWORK_SONIC_CHAIN_ID=146                    # required
RPC_SONIC=wss://...,https://...               # required (no public default)
NETWORK_SONIC_NAME=Sonic                      # optional, shown in alerts
NETWORK_SONIC_EXPLORER=https://sonicscan.org  # optional, else Blockscan links
NETWORK_SONIC_DEXSCREENER=sonic               # optional, DexScreener URL slug
```

The env var fragment is the key upper-cased with `-` → `_` (key `zk-sync`
→ `NETWORK_ZK_SYNC_CHAIN_ID`, `RPC_ZK_SYNC`). A declared network is watched
automatically — it doesn't also need listing in `ENABLED_NETWORKS` — and
shows up in `/add_token`, `/settings` and the alert card. A network with a
missing/invalid chain id or RPC is skipped with an error in the startup
log instead of crashing the bot, and every other network keeps running.
Deployer lookup works for it only if Etherscan's multichain API covers that
chain id; `owner()`/`admin()` discovery works regardless.

## Getting started

```bash
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and at least one RPC_<NETWORK> per chain you want to watch

docker compose up -d       # Postgres + Redis
npm install
npm run db:migrate         # creates tables (also runs automatically on boot)
npm run dev                # or: npm run build && npm start
```

### Required configuration

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather).
- `RPC_<NETWORK>` (e.g. `RPC_ETHEREUM`, `RPC_ARBITRUM`) — comma-separated
  list of RPC URLs; the first is primary, the rest are automatic failover
  endpoints (Alchemy / QuickNode / Ankr / Blockpi, etc). A `wss://` URL gets
  a push WebSocket subscription for near-instant new-block notifications
  (needed for the spec's 5–10s alert-latency target); `http(s)://` falls
  back to polling. Public fallback RPCs (HTTP only) are used if unset, but
  they're rate-limited and unsuitable for production.
- `ETHERSCAN_API_KEY` — optional, enables "Contract Creator" (deployer)
  lookups via Etherscan's unified multichain API (one key covers every
  supported network). Without it, owner discovery still works for tokens
  that expose `owner()`/`admin()`/`DEFAULT_ADMIN_ROLE` on-chain.
- `SIGNATURE_DB_URL` — optional; the OpenChain-compatible signature database
  used to name functions of unverified contracts (default
  `https://api.4byte.sourcify.dev/signature-database/v1/lookup`, `off` to
  disable). If it's unreachable, detection still works but project-specific
  names like `migrateFromLEND` aren't recognised, so such migrators score
  MEDIUM instead of HIGH.
- `MAX_CATCHUP_BLOCKS` — optional (default `2000`); after a restart each
  network replays at most this many missed blocks (older ones are skipped
  and counted in `/status`).
- `RECHECK_DELAYS_SEC` — optional (default `120,600,3600,21600`); when a
  contract is detected without Token B it is re-analyzed after each of these
  delays until Token B is found.
- `OWNER_REFRESH_INTERVAL_HOURS` — optional (default `24`, `0` disables);
  how often every tracked token's owners are re-discovered. Newly found
  wallets (e.g. ownership moved to a multisig) are linked automatically and
  the chat that added the token is told. Old wallets are kept.
- `AUTO_DISCOVERY` — optional (default `true`); scan every new contract, not
  only tracked wallets'. `AUTO_DISCOVERY_NETWORKS` limits it to some networks
  (comma-separated; empty = all enabled ones) — it reads and traces every
  block, the costliest part in RPC quota. `AUTO_CONCURRENCY` (default `8`)
  parallel analyses.
- `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_API_PASSPHRASE` (+ optional
  `OKX_PROJECT_ID`) — OKX Web3 / DEX API credentials for the liquidity test.
  `AUTO_REQUIRE_LIQUIDITY=false` sends auto alerts even when the test
  couldn't run (not recommended: that's what filters the spam).
- `OKX_MIN_INTERVAL_MS` — optional (default `1100`); OKX rate-limits DEX
  API keys (error 50011), so quotes go out one at a time this far apart and
  a 50011 is waited out and retried. `/status` shows cached OKX health
  (refreshed in the background every 10 min) instead of querying each time.
- `AUTO_DEDUP_HOURS` — optional (default `24`, `0` disables).
- `QUOTE_TOKEN_<NETWORK>` — optional override of the stablecoin the test
  swaps from, `<address>:<decimals>[:<symbol>]` (defaults: USDT, or USDC /
  USDB / USDT0 where that's the chain's main dollar).
  `BASE_ASSETS_<NETWORK>` — extra comma-separated addresses never treated as
  a migration's Token A (wrapped native and major stables are built in).
- `CUSTODIAN_DEPLOYERS` — optional seed of the RWA custodian registry,
  `network:0xaddress:Label,...`.
- `CUSTODIAN_NETWORKS` — optional networks watched only for custodians'
  deployments (e.g. `arbitrum,robinhood`), polled every `CUSTODIAN_POLL_MS`
  (default `3000`); `CUSTODIAN_WATCH=false` turns the watch off.
- `ADMIN_CHAT_IDS` — comma-separated Telegram numeric chat/user IDs (not
  `@usernames`) that are administrators. Required for anyone other than the
  admins themselves to ever use the bot — see "Access control" below.

## Access control & languages

Every chat that messages the bot for the first time is walked through:

1. **Language picker** — English / Українська / Русский, shown as inline
   buttons. Change it later any time with `/language`.
2. **Approval gate** — unless the chat's ID is listed in `ADMIN_CHAT_IDS`, no
   command does anything until an administrator approves it. Each admin
   chat gets a one-time "🆕 New access request" message with Approve/Reject
   buttons (in *their* chosen language) the first time a chat finishes
   picking a language; approving/rejecting notifies the requester. An admin
   chat must have sent `/start` to the bot at least once for it to be able
   to message them (Telegram requires the bot to have prior contact).

All bot text — commands, errors, the settings UI, and the alert card itself
— is localized per chat from `src/telegram/i18n/translations.ts`; add a
fourth language there (and to the `Language` type in `src/types/index.ts`)
if you need one.

## Auto-discovery (all new contracts)

With `AUTO_DISCOVERY=true` (the default) the bot doesn't need `/add_token` to
find migrations. For every block on every enabled network:

1. **Every contract created** is collected: direct deployments (address from
   sender + nonce, no extra RPC call) and factory `CREATE`/`CREATE2`
   deployments. `AUTO_TRACE_MODE` picks how factories are traced:
   `calldata` (default) traces only calls whose calldata carries creation
   code — CREATE2 deployers (CreateX, Arachnid), clone factories — and every
   call from or into a registered custodian, a tiny share of traffic;
   `block` traces every block with `debug_traceBlockByNumber` /
   `trace_block` (also catches factories that hold the child's code
   themselves). `AUTO_BLOCK_TRACE_NETWORKS` picks the networks traced per
   block, by default `ethereum`: one block per 12s at 40 CU a trace on
   Alchemy is cheap, while on L2s producing several blocks a second it
   isn't (across 12 networks that ran to ~9,000 CU/s of throughput). Where
   block tracing turns out unavailable the network falls back to
   `calldata`. `off` = direct deployments only.
2. **Signature gate** — kept only if the dispatcher has a `migrate*` /
   `convert*` action (not settings/flags that merely mention it —
   `setMigratedPool`, `migratedPools`, `isConverted` — nor ERC-4626's
   `convertToShares`/`convertToAssets`), an `oldToken()`-style getter (`oldToken`,
   `legacyToken`, `previousToken`, `v1Token`…; not `tokenIn`/`fromToken`,
   which every swap bot has), or an `xToY` converter whose x and y are its own
   token getters. `swap*`/`exchange*` alone never qualify — bots, zaps and
   presales are full of them — except a bare `swap(uint256)` /
   `exchange(uint256)` ("TokenSwap" migrators), which is then alerted only if
   Token B has no DEX market yet (a new token; a bot trades two liquid ones).
   A candidate also needs a Token B (address, or ticker → Unverified); one
   without is re-checked later. Spam shapes are dropped here: DEX pools (`token0()`/`token1()`),
   ERC-4626 vaults (`asset()` + `totalAssets()` + `convertTo*` — even with a `migrate()`),
   ERC-20s whose only "swap" is fee plumbing (`swapTokensForEth`), contracts
   that reference no other token.
3. **Token A / Token B by address only** — every ERC-20 the contract returns
   from zero-argument getters, takes in its constructor, or has compiled into
   its code (constants and `immutable`s, e.g. Aave's `LEND`/`AAVE`). Old vs new is
   decided from names (`oldToken`/`newToken`, `migrateFromLEND` → `LEND()`,
   `mkrToSky` → `mkr()`/`sky()`); a token with `migrate()` is itself Token B;
   when names don't tell, the token with a market is Token A. Wrapped native
   and stablecoins are never Token A. Symbols are only displayed — never
   matched — so same-ticker tokens on other chains can't be confused. A
   target given only as a ticker (e.g. `newTokenSymbol()`) is shown as
   **Unverified** and the alert is LOW. A migrator deployed empty (tokens
   set by a later `setTokens()`/`initialize()`) or a proxy deployed without
   its implementation is re-checked on the `RECHECK_DELAYS_SEC` schedule.
4. **Liquidity test (OKX DEX aggregator, `GET /api/v6/dex/aggregator/quote`)**
   — a quote for $300 then $1,000 of the network's dollar stablecoin into
   Token A. PASS = `code == 0`, a route, and price impact within the chat's
   level: **Strict** ($1,000 / ≤ 5%, default), **Low-Cap** ($300 / ≤ 10%) or
   **Deep** ($10,000 / ≤ 3% — only tokens with a pool of roughly $300k+),
   chosen per chat in `/settings`; each is tunable with
   `LIQUIDITY_<LEVEL>=<usd>:<max impact %>` (e.g. `LIQUIDITY_DEEP=25000:2`). No route / too much impact / honeypot =
   dropped. Results are cached per token for 5 minutes; an OKX outage is
   retried rather than cached.
5. **Dedup** — the same token pair, or the same contract code (clones, bot
   fleets), alerts once per `AUTO_DEDUP_HOURS` (default 24).
6. **Alert** to every approved chat that has auto alerts on and whose level
   the token passes. The card shows the source (auto-discovery), Token A's
   full address, and the test swaps (`$1,000 → 0.80% ✅ · $300 → 0.20% ✅`).

**RWA / tokenized stocks.** `isin()`, `cusip()`, `underlyingAsset()` and
`issuer()` getters are recognised and shown on the card. Deployers of
tokenized stocks (Backed Finance, Dinari, Robinhood...) can be registered as
custodians with `/add_custodian` (or `CUSTODIAN_DEPLOYERS`), matched by the
wallet sending the transaction, the contract it calls, or the factory that ran
the CREATE; their migration-style deployments are alerted without the DEX
test, since tokenized stocks don't trade on DEXes at launch (a plain new stock
token is not a migration and isn't alerted). Built in, each seeded once (then
the registry is the admins'):

| Network | Custodian | Address | Source |
|---|---|---|---|
| Arbitrum | Robinhood (Classic Stock Tokens) | `0xcBdF…f556` | Arbiscan label "Robinhood: Deployer" |
| Robinhood Chain | Robinhood `StockFactory` (Stock Tokens) | `0x4783…C046` | creator of every Stock Token there |
| Ethereum | Backed Finance (bTokens / xStocks) | `0x5F7A…a2aD` | Etherscan label "Backed: Deployer" |
| Ethereum, Arbitrum, Base, Blast | Dinari `DShareFactory` | see `custodianRepository.ts` | `dinaricrypto/sbt-contracts` v0.4.0 |

**Custodian watch.** On networks where auto-discovery reads every block,
custodians are covered by it. Elsewhere — enabled networks without
auto-discovery, plus `CUSTODIAN_NETWORKS` — the bot does **not** read blocks:
every deployment bumps the deployer's nonce (a wallet's with each transaction,
a factory contract's with each CREATE/CREATE2), so it polls the custodians'
transaction counts every `CUSTODIAN_POLL_MS` (3s), and only when one rose
bisects historical counts to the exact block(s) and reads those. Idle cost:
one `eth_blockNumber` plus one `eth_getTransactionCount` per custodian per
poll — against ~10 full blocks a second on Robinhood Chain. Deployments made
while the bot was down are found after a restart (resumes from the saved
block), and `/status` has a line per watched network.

**Turning Robinhood on** (without full auto-discovery on those chains):

```
ENABLED_NETWORKS=ethereum
AUTO_DISCOVERY_NETWORKS=ethereum
CUSTODIAN_NETWORKS=arbitrum,robinhood
RPC_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/<key>
RPC_ROBINHOOD=https://robinhood-mainnet.g.alchemy.com/v2/<key>
```

Robinhood Chain (chain id 4663) has a public RPC (used when `RPC_ROBINHOOD`
isn't set) but it is rate-limited; Alchemy serves it on the same key. OKX's
DEX API and DexScreener both cover it; set `QUOTE_TOKEN_ROBINHOOD` before
enabling full auto-discovery there (no stablecoin is built in for it yet).

**Infrastructure.** Auto-discovery reads every block in full and traces it,
so it needs WebSocket RPCs with plenty of throughput (the spec asks for
50–100 RPS per network via QuickNode, Chainstack or Alchemy) and an endpoint
that supports `debug_traceBlockByNumber` or `trace_block`. Without OKX keys
no auto alert could pass the liquidity filter, so auto-discovery stays
paused (it would only burn RPC quota) and `/status` says so; tracked
projects' alerts are unaffected.

## Bot commands

```
/add_token <network> <token_a_address>            Track a token, auto-discover its owners
/list                                             Paginated list of tracked tokens and their owners
/remove_token <token_a_address>                   Ask for confirmation, then stop tracking a token
/add_owner <network> <token> <owner_address>       Manually link an extra wallet (dev, multisig) to a tracked token
/remove_owner <network> <token> <owner_address>    Unlink a manually-added wallet
/settings                                         Inline-keyboard toggles for confidence + network filters
/language                                         Change the bot's language
/analyze <network> <deploy_tx_hash> [token_a]     Analyze any already-deployed contract on demand
/status                                           Admins only: per-network health, lag, errors, queue, auto-discovery, OKX
/custodians, /add_custodian, /remove_custodian    Admins only: RWA deployer registry
```

`/status` shows, per enabled network: 🟢/🟡/🔴 (last block processed under
2 min / 10 min / longer ago), websocket or polling mode, the last processed
block and how far behind the chain head it is, whether factory tracing works
on that RPC, plus blocks skipped after a long downtime, blocks that failed
every retry, and the last RPC error. Also totals (tokens, wallets, detected
contracts) and the analysis queue, including scheduled re-checks.

`/analyze` runs the same analyzer on the contract(s) an already-mined
transaction created — a direct deploy or a factory call — and replies with
the alert card (titled "Contract analysis"; nothing is stored or
broadcast). Take the hash from the "Contract Creator" field of the
contract's explorer page. Token A is the optional third argument, else a
tracked token owned by the creator, preferring one the contract references.
It's the zero-cost way to check detection against real migration contracts.

When a deployer owns several tracked tokens, a detection is attributed to
the token whose address appears in the deploy input (constructor args /
inlined immutables), falling back to a same-network token. Owners are
watched on every enabled network, so a team deploying its migrator on a
different chain than Token A is still caught — the card links to the chain
the contract was actually deployed on.

`/list` and `/settings` render inline keyboards (Prev/Next, per-network and
per-confidence toggle buttons) rather than taking extra text arguments;
`/remove_token` shows a Confirm/Cancel keyboard before deleting anything.

## Deploying on Railway

`railway.json` pins the build (`npm run build`) and start (`npm start`)
commands so Nixpacks doesn't have to guess, and intentionally sets no
`healthcheckPath` — this is a background bot/listener process with no HTTP
port to probe, so Railway's HTTP healthcheck must stay off (it would
otherwise report the deploy "unhealthy" even though it's running fine).

1. New Railway project → Deploy from GitHub → this repo.
2. Add the **PostgreSQL** and **Redis** plugins to the project; they inject
   `DATABASE_URL` / `REDIS_URL` automatically, matching what `src/config/env.ts`
   already reads.
3. Set the variables from "Required configuration" above (`TELEGRAM_BOT_TOKEN`,
   at least one `RPC_<NETWORK>`, `ENABLED_NETWORKS`) in the service's
   Variables tab.
4. Deploy. Migrations run automatically on boot (`runMigrations()` in
   `src/index.ts`) — no separate migrate step needed.

## Tests

```bash
npm test        # node's built-in test runner + tsx, covers pure logic:
                 # selector scanning, confidence scoring, constructor-arg
                 # extraction, the alert-card formatter, settings toggles,
                 # and that all three languages have matching translation keys
npm run typecheck
```

### End-to-end test (local chain)

`npm run test:e2e` runs the real pipeline — WebSocket block listener →
BullMQ → analyzer → Postgres → alert card — against a local
[anvil](https://book.getfoundry.sh/anvil/) chain. It deploys the fixture
contracts in `e2e/Fixtures.sol` from a tracked owner and checks each
verdict:

| Scenario | Expected |
|---|---|
| `newToken()`/`oldToken()`/`rate()` getters + `migrate()` + `Migrated` event | HIGH, Token B via getter |
| Tokens only in private storage (constructor args) | HIGH, Token B via constructor |
| Constructor references only Token A | HIGH, Token B left unset |
| `claim()` but no token configured yet | MEDIUM |
| Unrelated contract | LOW |
| Same contract deployed by a non-owner wallet | not detected |
| Migrator deployed through a factory via `CREATE2` | HIGH (trace-based detection) |
| Migrator behind an EIP-1967 proxy / EIP-1167 clone | HIGH / MEDIUM (implementation scanned) |
| Aave-style: `migrateFromLEND`, `LEND()`/`AAVE()`, behind a proxy | HIGH, Token B via `AAVE()` |
| Sky-style: `mkrToSky`, Token A with a `bytes32` symbol | HIGH, symbol reads as `MKR` |
| Polygon-style: `polygonEcosystemToken()` behind a proxy | HIGH |
| USDT-style ERC-20 with `redeem()` (control) | LOW |
| Migrator deployed while the listener is stopped | caught after restart |
| Logic deployed uninitialized, `initialize()` called later | update card with Token B |
| Token ownership transferred to a new wallet | refresh links it; its deploys are caught |
| `/status` | network shown healthy with block and lag |

The harness runs a local stub of the signature database, so function naming
is exercised offline too.

Prerequisites: `anvil --block-time 1` on `:8545`, plus Postgres and Redis
(`docker compose up -d`). The Telegram send itself is the only thing not
exercised — the harness prints the rendered card instead. To change the
fixtures, edit `e2e/Fixtures.sol` and regenerate `e2e/artifacts.json` with
`npm i --no-save solc@0.8.24 && node e2e/compile.cjs`.

### Bot acceptance test (Telegram layer)

`npm run test:bot` drives the real bot — every command, inline button,
access flow and language — and live alert delivery, against the same local
chain and a fake Telegram Bot API that rejects what the real one would
(broken MarkdownV2, texts over 4096 chars, button data over 64 bytes). It
covers: language picker and admin approve/reject; blocking of unapproved,
rejected and not-set-up chats; `/add_token` (validation, owner discovery,
re-add), paginated `/list`, `/add_owner`, `/remove_token` confirm/cancel,
`/settings` filters, `/analyze`, `/status` (admin vs non-admin); alert
routing by approval, confidence filter, network filter and chat language;
deploys from a manually linked wallet; the update card after a late
`initialize()`; the owner-change notice; group chats (`/cmd@botname`,
negative chat ids); a chat that blocked the bot (403) and flood control
(429, waited out and retried); `/list` for a token with 60+ wallets staying
under the length limit; and that no message has an unfilled placeholder or
raw translation key.

### Auto-discovery test

`npm run test:auto` runs the auto-discovery pipeline with a stub of the OKX
DEX API and checks: alerts from untracked deployers without `/add_token`;
a same-ticker token of another project not being attributed to the tracked
one; tracked owners still taking the priority path; no-route Token A
dropped; Aave-style direction from `migrateFromLEND`; constructor-only
tokens ordered by which has a market; a token that is its own Token B;
ticker-only target → LOW + Unverified; DEX pairs, fee-swap meme tokens,
WETH "migrations" and plain contracts ignored; Strict vs Low-Cap routing;
OKX outage retried; RWA custodian deployments alerted without a DEX market
(and the same contract from anyone else not); a `CREATE2` child found via
`trace_block`; per-token caching of OKX quotes; deploy → alert ≤ 10s; and
every card valid MarkdownV2 in all three languages. It also deploys **real
production bytecode** pulled from npm by `node e2e/fetch-real-artifacts.cjs`
(stored in `e2e/real-artifacts.json`): Aave's `LendToAaveMigrator` (found
with A = LEND, B = AAVE, no `/add_token`), Aave's own proxy deployed empty
and `initialize()`d later (found on re-check), and Uniswap V2's factory and a
`createPair` CREATE2 pair (ignored). Plus: tokens only as immutables in the
code, a migrator configured by a later `setTokens()`, a custodian recognised
by its factory contract, and a load run — one block with 151 new contracts
(150 spam: pools, fee tokens, plain tokens, counters) where the one migration
must alert within 10s and no spam may.

### Custodian watch test

`npm run test:custodian` runs the custodian watch against anvil through a
counting RPC proxy: idle blocks cost no block reads at all; a migration
contract deployed by a custodian wallet, by an operator calling the
custodian's `StockFactory` (CREATE), through a forwarder/multisig, and by a
CREATE2 custodian factory is alerted within seconds; a new stock token is seen
but not alerted; a non-custodian's migrator is left to auto-discovery; and 55
deployments in 55 blocks made while the bot was stopped are all found after
the restart, reading only those 55 blocks.

### Resilience test

`npm run test:resilience` puts a TCP proxy between the bot and anvil and
breaks it: a dropped WebSocket; a provider outage of `OUTAGE_SEC` (default
90s, well past viem's own ~10s reconnect window) with a deploy mined during
it; a WebSocket that stays open but silently stops delivering (only the
listener's watchdog can notice); and a block packed with 300 transactions
plus two owner deploys. Every deploy must still be detected.

## Known limitations / extension points

- **Factory-deployed contracts (`CREATE2` via a factory)**: detected via
  `debug_traceTransaction` (see `src/chain/traceCreateDetector.ts`), but only
  on RPC endpoints that expose the `debug` namespace — not every free-tier
  provider does. A network whose endpoint answers "method not supported",
  or fails three calls in a row, has factory detection paused for 6 hours
  (logged, and shown in `/status`); a single transient failure just
  retries the block. Meanwhile direct EOA deployments (`to == null`) keep working
  regardless. Set `ENABLE_FACTORY_TRACE_DETECTION=false` to skip it
  entirely.
- **Constructor argument decoding** is heuristic (see
  `src/analyzer/constructorArgsDecoder.ts`): without the deployed contract's
  ABI/source there's no reliable way to find the exact byte offset where
  constructor args start, so it scans trailing 32-byte words for
  address-shaped values and verifies each against ERC-20 getters.
- **Deployer lookup** uses Etherscan's unified multichain API (`chainid`
  param), so `ETHERSCAN_API_KEY` alone covers every supported network — no
  per-network key needed.
- **Mempool monitoring is intentionally not implemented.** The spec lists it
  as a data source, but for this use case it wouldn't actually shorten the
  alert path: a `CREATE` contract's address is derivable pre-confirmation,
  but its bytecode — which the analyzer needs for selector/event scanning —
  only exists once the deploy tx is mined, so watching pending transactions
  buys at most one RPC round-trip versus reacting to the mined block. The
  WebSocket block subscription above gets the real latency win; mempool
  watching would add a second live subscription and reconnect-handling path
  for a marginal gain, so it's left out rather than half-built.
- **Confidence score is a supplementary display number, not a threshold
  gate.** The HIGH/MEDIUM/LOW label (which `/settings confidence high`
  filters on) follows the spec's rule directly — needs a Token B signal
  *and* migration-style functions for HIGH. The 0–100% score in the card
  (`src/analyzer/migrationAnalyzer.ts: computeConfidenceScore`) is a
  separately-weighted number for the same evidence, shown for extra context;
  it isn't what decides the label.
