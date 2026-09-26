# Multi-EVM Token Migration Tracker

Real-time monitor for EVM networks that watches known token owners/admins
for new contract deployments, classifies whether a new contract looks like a
migration mechanism into a second token, and pushes alert cards to Telegram.

Implements the architecture from the project spec:

1. **Token & Owner DB** — tracked "Token A" contracts plus their discovered
   deployer / `owner()` / `admin()` / `DEFAULT_ADMIN_ROLE` addresses.
2. **Multi-EVM block listener** — polls new blocks on every configured
   network and flags contract-creation transactions from tracked owners.
3. **Migration analyzer** — decodes constructor args, scans bytecode for
   migration-style function selectors, and static-calls common "Token B"
   getters to assign a HIGH / MEDIUM / LOW confidence score.
4. **Telegram bot** — `/add_token`, `/list`, `/remove_token`, `/settings`,
   and the alert card itself.

## Stack

TypeScript (Node.js) + [viem](https://viem.sh) + PostgreSQL + Redis
([BullMQ](https://docs.bullmq.io)) + [Telegraf](https://telegraf.js.org).

## Supported networks

Ethereum, BNB Smart Chain, Arbitrum One, Base, Optimism, Polygon, Avalanche,
Linea, Scroll, Blast, Polygon zkEVM — see `src/config/networks.ts`. Adding a
network means adding one entry there plus an `RPC_<NETWORK>` env var.

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
  endpoints (Alchemy / QuickNode / Ankr, etc). Public fallback RPCs are used
  if unset, but they are rate-limited and unsuitable for production.
- `ETHERSCAN_API_KEY` / `BSCSCAN_API_KEY` / `ARBISCAN_API_KEY` — optional,
  enables "Contract Creator" (deployer) lookups on those networks via the
  explorer API. Without a key, owner discovery still works for tokens that
  expose `owner()`/`admin()`/`DEFAULT_ADMIN_ROLE` on-chain.

## Bot commands

```
/add_token <network> <token_a_address>   Track a token, auto-discover its owners
/list                                    Paginated list of tracked tokens and their owners
/remove_token <token_a_address>          Ask for confirmation, then stop tracking a token
/settings                                Inline-keyboard toggles for confidence + network filters
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
                 # extraction, the alert-card formatter, settings toggles
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
- **Deployer lookup** depends on an Etherscan-family explorer API key per
  network; add more networks to `explorerApis` in
  `src/chain/ownerDiscovery.ts` as needed (or switch to a unified
  multi-chain explorer API).
