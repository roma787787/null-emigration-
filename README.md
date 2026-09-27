# Multi-EVM Token Migration Tracker

Real-time monitor for EVM networks that watches known token owners/admins
for new contract deployments, classifies whether a new contract looks like a
migration mechanism into a second token, and pushes alert cards to Telegram.

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
Avalanche, Linea, Scroll, Blast, Polygon zkEVM, HyperEVM (see
`src/config/networks.ts`). Keys for `ENABLED_NETWORKS`: `ethereum, bsc,
arbitrum, base, optimism, polygon, avalanche, linea, scroll, blast,
polygon-zkevm, hyperevm`.

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
/status                                           Admins only: per-network health, lag, errors, queue
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
