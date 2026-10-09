import { decodeFunctionResult, isAddressEqual, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import type { MigrationTerms, NetworkKey } from "../types/index.js";
import { getPublicClient } from "../chain/provider.js";
import { checkLiquidity, quoteForPrice, quoteSwap, type LiquidityCheck, type PriceQuote } from "../liquidity/okxLiquidity.js";
import { quoteTokenFor } from "../config/marketAssets.js";
import { readTokenSymbol } from "../chain/tokenMetadata.js";
import { logger } from "../utils/logger.js";
import { inspectContract } from "./migrationAnalyzer.js";
import { interpretRatio, newPerOldFromRaw, simulateExchange, type SimulatedExchange } from "./migrationRate.js";

/**
 * The terms a trader needs to act on a migration, read from the contract
 * itself: whether it is open (or when it opens and closes), at what ratio,
 * whether the new tokens are already there, and what both tokens trade at.
 * Every part is optional — contracts expose what they expose.
 */

const getters = (...sigs: string[]) => sigs.map((sig) => ({ sig, selector: toFunctionSelector(sig) }));

const PAUSED = getters("paused()", "isPaused()");
const ACTIVE = getters(
  "migrationActive()", "isMigrationActive()", "isActive()", "active()", "enabled()", "migrationEnabled()",
  "isOpen()", "migrationOpen()", "isMigrationOpen()", "started()", "migrationStarted()", "isMigrationEnabled()",
);
const ENDED = getters("migrationEnded()", "ended()", "isEnded()", "closed()", "finished()", "migrationClosed()");
const START = getters(
  "startTime()", "startTimestamp()", "migrationStart()", "migrationStartTime()", "start()", "openTime()",
  "startDate()", "startAt()", "migrationStartsAt()", "startsAt()",
);
const END = getters(
  "endTime()", "endTimestamp()", "deadline()", "migrationEnd()", "migrationEndTime()", "migrationDeadline()",
  "end()", "closeTime()", "endDate()", "endAt()", "expiry()", "expiration()", "endsAt()",
);
const RATIO = getters(
  "ratio()", "rate()", "exchangeRate()", "conversionRate()", "migrationRate()", "swapRatio()", "swapRate()",
  "conversionRatio()", "migrationRatio()",
);

const BALANCE_ABI = [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;
const DECIMALS_ABI = [{ type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }] as const;

/** A unix timestamp a contract would plausibly hold (2015–2100); block numbers and durations are not dates. */
const isTimestamp = (v: bigint) => v >= 1_420_000_000n && v <= 4_102_444_800n;

async function word(client: PublicClient, address: Address, selector: Hex): Promise<bigint | null> {
  try {
    const { data } = await client.call({ to: address, data: selector });
    return data && data.length === 66 ? BigInt(data) : null;
  } catch {
    return null;
  }
}

/** The first of `list` the contract implements that answers, as a raw word. */
async function first(client: PublicClient, address: Address, selectors: Hex[], list: { sig: string; selector: Hex }[]) {
  for (const g of list) {
    if (!selectors.includes(g.selector)) continue;
    const value = await word(client, address, g.selector);
    if (value !== null) return { getter: g.sig, value };
  }
  return null;
}

export async function tokenDecimals(client: PublicClient, token: Address): Promise<number | null> {
  const d = await client.readContract({ address: token, abi: DECIMALS_ABI, functionName: "decimals" }).catch(() => null);
  return d === null ? null : Number(d);
}

/** USD per whole token from a test swap of $amountUsd: amountUsd / tokens bought. Includes the swap's impact. */
export function priceFromCheck(check: LiquidityCheck | undefined, decimals: number | null): number | null {
  if (!check || check.status !== "pass" || !check.amountOut || decimals === null) return null;
  const tokens = Number(BigInt(check.amountOut) * 1_000_000n / 10n ** BigInt(decimals)) / 1_000_000;
  return tokens > 0 ? check.amountUsd / tokens : null;
}

/** Buy the old token, migrate (newPerOld new tokens each), sell the new ones: what that earns, in percent. */
export function spreadPercent(oldPrice: number | null, newPrice: number | null, newPerOld = 1): number | null {
  return oldPrice && newPrice ? ((newPrice * newPerOld - oldPrice) / oldPrice) * 100 : null;
}

/** "1,234,567.89" from a raw amount — never in exponent notation. */
export function formatAmount(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  const cents = decimals >= 2 ? (raw / 10n ** BigInt(decimals - 2)) % 100n : 0n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents > 0n && whole < 1_000_000n ? `${grouped}.${cents.toString().padStart(2, "0")}` : grouped;
}

export interface TermsInput {
  network: NetworkKey;
  contractAddress: Address;
  tokenAAddress: Address | null;
  tokenBAddress: Address | null;
  /** The contract's dispatcher selectors (proxy + implementation). */
  selectors: Hex[];
  /** Selector → text signature, for ratio getters with project-specific names (LEND_AAVE_RATIO). */
  signatures?: Map<string, string>;
  /** Token A's $300 test swap, if already made. */
  tokenACheck?: LiquidityCheck;
  now?: number;
}

/** Status, dates, ratio, funding and prices. Never throws; what can't be read is left out. */
export async function readMigrationTerms(input: TermsInput): Promise<MigrationTerms> {
  const client = getPublicClient(input.network);
  const { contractAddress: at, selectors } = input;
  const now = BigInt(Math.floor((input.now ?? Date.now()) / 1000));
  const terms: MigrationTerms = { status: "unknown", startsAt: null, endsAt: null, ratio: null, funding: null, prices: null };

  try {
    const [paused, active, ended, start, end] = await Promise.all([
      first(client, at, selectors, PAUSED),
      first(client, at, selectors, ACTIVE),
      first(client, at, selectors, ENDED),
      first(client, at, selectors, START),
      first(client, at, selectors, END),
    ]);
    if (start && isTimestamp(start.value)) terms.startsAt = Number(start.value);
    if (end && isTimestamp(end.value)) terms.endsAt = Number(end.value);
    terms.status =
      ended?.value === 1n || (terms.endsAt !== null && BigInt(terms.endsAt) <= now) ? "ended"
      : paused?.value === 1n ? "paused"
      : terms.startsAt !== null && BigInt(terms.startsAt) > now ? "not_started"
      : active?.value === 0n ? "not_started"
      : active?.value === 1n || terms.startsAt !== null || paused?.value === 0n ? "open"
      : "unknown";

    const named = [...(input.signatures ?? new Map()).entries()]
      .filter(([sel, sig]) => sig.endsWith("()") && /(ratio|rate)$/i.test(sig.slice(0, -2)) && selectors.includes(sel as Hex))
      .map(([sel, sig]) => ({ sig, selector: sel as Hex }));
    const ratio = await first(client, at, selectors, [...RATIO, ...named]);
    if (ratio && ratio.value > 0n) terms.ratio = { getter: ratio.getter, value: ratio.value.toString() };

    // Where the new tokens come from: already on the contract, or minted on exchange.
    const selfToken = input.tokenBAddress && isAddressEqual(input.tokenBAddress, at);
    if (selfToken) {
      terms.funding = { kind: "mint" };
    } else if (input.tokenBAddress) {
      const [balance, decimals, symbol] = await Promise.all([
        client.readContract({ address: input.tokenBAddress, abi: BALANCE_ABI, functionName: "balanceOf", args: [at] }).catch(() => null),
        tokenDecimals(client, input.tokenBAddress),
        readTokenSymbol(client, input.tokenBAddress).catch(() => null),
      ]);
      if (balance !== null && decimals !== null) {
        terms.funding = { kind: "balance", amount: formatAmount(balance, decimals), empty: balance === 0n, symbol };
      }
    }

    const market = await readMarket(input.network, input.tokenAAddress, input.tokenBAddress, input.tokenACheck);
    if (market) {
      const { prices, checkA, decA, decB } = market;
      // The exchange simulated with what $300 buys — at the start time if it opens later, funded if it holds nothing yet.
      const simulated =
        input.tokenAAddress && input.tokenBAddress && decA !== null && decB !== null
          ? await simulateExchange(client, {
              contract: at,
              tokenA: input.tokenAAddress,
              tokenB: input.tokenBAddress,
              signatures: input.signatures ?? new Map(),
              selectors,
              amount: checkA.status === "pass" && checkA.amountOut ? BigInt(checkA.amountOut) : 10n ** BigInt(decA),
              at: terms.status === "not_started" && terms.startsAt ? terms.startsAt + 60 : null,
              fundContract: terms.funding?.kind === "balance",
            }).catch(() => null)
          : null;
      terms.rate = resolveRate(simulated, terms.ratio, decA, decB, prices);
      const usable = terms.rate && terms.rate.source !== "market" ? terms.rate : null;
      prices.spreadPercent = usable ? spreadPercent(prices.oldUsd, prices.newUsd, usable.newPerOld) : null;
      const roundTrip =
        usable && input.tokenBAddress && prices.newUsd !== null
          ? await readRoundTrip(input.network, input.tokenBAddress, checkA, decA, decB, usable.newPerOld, simulated)
          : null;
      terms.prices = roundTrip ? { ...prices, roundTrip } : prices;
    }
  } catch (err) {
    logger.warn({ err, network: input.network, contractAddress: at }, "Reading migration terms failed");
  }
  return terms;
}

/** A small price quote's USD per whole token. */
export function priceFromQuote(quote: PriceQuote | null, decimals: number | null): number | null {
  if (!quote || decimals === null) return null;
  const tokens = Number(BigInt(quote.amountOut) * 1_000_000n / 10n ** BigInt(decimals)) / 1_000_000;
  return tokens > 0 ? quote.amountUsd / tokens : null;
}

/** Impact above this on the small price quote marks the market thin. */
const THIN_IMPACT_PERCENT = 5;

/** No rate in the contract, but prices this close to 1:1 (within 2×) are taken as 1:1. */
const ONE_TO_ONE_BAND = 2;

/**
 * The rate a trader can act on: the simulated exchange; else the ratio
 * getter read the way prices agree with; else, with no rate the contract
 * gives up, 1:1 when prices sit near it — or the market's own ratio, an
 * estimate the trade is not computed from.
 */
export function resolveRate(
  simulated: SimulatedExchange | null,
  ratio: MigrationTerms["ratio"],
  decA: number | null,
  decB: number | null,
  prices: { oldUsd: number | null; newUsd: number | null } | null,
): MigrationTerms["rate"] {
  if (decA === null || decB === null) return null;
  if (simulated) return { newPerOld: newPerOldFromRaw(simulated.received, simulated.spent, decA, decB), source: "simulated" };
  const market = prices?.oldUsd && prices.newUsd ? prices.oldUsd / prices.newUsd : null;
  if (ratio) {
    const read = interpretRatio(BigInt(ratio.value), decA, decB, market);
    if (read) return { newPerOld: read.newPerOld, source: "ratio", checked: read.checked };
    return market ? { newPerOld: market, source: "market" } : null;
  }
  if (!market) return null;
  return market <= ONE_TO_ONE_BAND && market >= 1 / ONE_TO_ONE_BAND ? { newPerOld: 1, source: "assumed" } : { newPerOld: market, source: "market" };
}

/**
 * USD prices of both tokens. The old token's comes from its $300 test swap
 * when that passed; otherwise — and always for the new token, whose market
 * is often thin at first — from a small quote with no impact cap, flagged
 * thin when it moved the price a lot. The spread and the trade come after,
 * once the rate is known.
 */
async function readMarket(
  network: NetworkKey,
  tokenA: Address | null,
  tokenB: Address | null,
  tokenACheck?: LiquidityCheck,
): Promise<{ prices: NonNullable<MigrationTerms["prices"]>; checkA: LiquidityCheck; decA: number | null; decB: number | null } | null> {
  if (!tokenA) return null;
  const client = getPublicClient(network);
  const checkA = tokenACheck ?? (await checkLiquidity(network, tokenA, "LOW_CAP"));
  const [decA, decB] = await Promise.all([tokenDecimals(client, tokenA), tokenB ? tokenDecimals(client, tokenB) : Promise.resolve(null)]);
  let oldUsd = priceFromCheck(checkA, decA);
  let oldThin = false;
  if (oldUsd === null) {
    const q = await quoteForPrice(network, tokenA);
    oldUsd = priceFromQuote(q, decA);
    oldThin = (q?.impactPercent ?? 0) > THIN_IMPACT_PERCENT;
  }
  const qB = tokenB ? await quoteForPrice(network, tokenB) : null;
  const newUsd = priceFromQuote(qB, decB);
  const newThin = (qB?.impactPercent ?? 0) > THIN_IMPACT_PERCENT;
  if (oldUsd === null && newUsd === null) return null;
  return {
    prices: {
      oldUsd,
      newUsd,
      spreadPercent: null,
      at: Date.now(),
      ...(oldThin && oldUsd !== null ? { oldThin } : {}),
      ...(newThin && newUsd !== null ? { newThin } : {}),
    },
    checkA,
    decA,
    decB,
  };
}

/** Raw old tokens as raw new tokens at newPerOld new per old (whole tokens), across decimals. */
export function migratedAmount(raw: bigint, fromDecimals: number, toDecimals: number, newPerOld = 1): bigint {
  const rate = BigInt(Math.round(newPerOld * 1e12));
  return (raw * rate * 10n ** BigInt(toDecimals)) / (10n ** 12n * 10n ** BigInt(fromDecimals));
}

/**
 * The migration trade quoted on both sides: what Token A's $300 test swap
 * bought, migrated at the rate (the simulated exchange's own output when
 * there is one), sold back into the stablecoin. Thin pools and slippage both
 * ways are in the number — unlike the spread of two prices.
 */
async function readRoundTrip(
  network: NetworkKey,
  tokenB: Address,
  checkA: LiquidityCheck,
  decA: number | null,
  decB: number | null,
  newPerOld: number,
  simulated: SimulatedExchange | null,
): Promise<NonNullable<MigrationTerms["prices"]>["roundTrip"] | null> {
  const stable = quoteTokenFor(network);
  if (checkA.status !== "pass" || !checkA.amountOut || decA === null || decB === null || !stable) return null;
  const bought = BigInt(checkA.amountOut);
  const newRaw = simulated ? (bought * simulated.received) / simulated.spent : migratedAmount(bought, decA, decB, newPerOld);
  const sold = await quoteSwap(network, tokenB, stable.address, newRaw);
  if (!sold) return { inUsd: checkA.amountUsd, outUsd: null, percent: null };
  const outUsd = Number((sold.amountOut * 100n) / 10n ** BigInt(stable.decimals)) / 100;
  return { inUsd: checkA.amountUsd, outUsd, percent: ((outUsd - checkA.amountUsd) / checkA.amountUsd) * 100 };
}

/** Terms for a detected contract, inspecting its code for the getters it has. Null when even that fails. */
export async function termsFor(
  network: NetworkKey,
  contractAddress: Address,
  tokenAAddress: Address | null,
  tokenBAddress: Address | null,
  tokenACheck?: LiquidityCheck,
): Promise<MigrationTerms | null> {
  try {
    const { selectors, signatures } = await inspectContract(network, contractAddress);
    return await readMigrationTerms({ network, contractAddress, tokenAAddress, tokenBAddress, selectors, signatures, tokenACheck });
  } catch (err) {
    logger.warn({ err, network, contractAddress }, "Migration terms unavailable");
    return null;
  }
}
