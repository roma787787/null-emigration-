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
   deployed through a factory.
3. **Migration analyzer** — decodes constructor args (including a Token-A
   self-reference check), scans bytecode for migration-style function
   selectors *and* event topics, static-calls "Token B" getters plus
   auxiliary signals (`oldToken()`, `rate()`), and assigns a HIGH / MEDIUM /
   LOW confidence label with a supplementary 0–100% score.
4. **Telegram bot** — `/add_token`, `/list`, `/remove_token`, `/add_owner`,
   `/remove_owner`, `/settings`, and the alert card itself. Every chat picks
   a language (English/Ukrainian/Russian) on first contact and needs
   administrator approval before any command works.

## Stack

TypeScript (Node.js) + [viem](https://viem.sh) + PostgreSQL + Redis
([BullMQ](https://docs.bullmq.io)) + [Telegraf](https://telegraf.js.org).

## Supported networks

Ethereum, BNB Smart Chain, Arbitrum One, Base, Optimism, Polygon, Avalanche,
Linea, Scroll, Blast, Polygon zkEVM, HyperEVM — see `src/config/networks.ts`.
Adding a network means adding one entry there plus an `RPC_<NETWORK>` env var.

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
```

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

Network-, Postgres- and Redis-dependent code (RPC calls, the block listener,
repositories) isn't covered by these — they need live infrastructure to
exercise meaningfully and are better validated against a real deployment.

## Known limitations / extension points

- **Factory-deployed contracts (`CREATE2` via a factory)**: detected via
  `debug_traceTransaction` (see `src/chain/traceCreateDetector.ts`), but only
  on RPC endpoints that expose the `debug` namespace — not every free-tier
  provider does. A network whose endpoint doesn't support it is
  auto-disabled for factory detection after the first failed call (logged
  once), while direct EOA deployments (`to == null`) keep working
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
