import { createHmac } from "node:crypto";
import type { LiquidityLevel, NetworkKey } from "../types/index.js";
import { getNetwork } from "../config/networks.js";
import { quoteTokenFor } from "../config/marketAssets.js";
import { logger } from "../utils/logger.js";

/**
 * Liquidity filter for auto-discovered migrations (spec task 3): instead of
 * listing-site data, ask the OKX DEX aggregator for an executable route —
 * "$1,000 of the network's dollar stablecoin → Token A" — and accept Token A
 * only if a route exists and its price impact stays under the level's cap.
 */

export type { LiquidityLevel };
export const LIQUIDITY_LEVELS: Record<LiquidityLevel, { amountUsd: number; maxImpactPercent: number }> = {
  STRICT: { amountUsd: 1000, maxImpactPercent: 5 },
  LOW_CAP: { amountUsd: 300, maxImpactPercent: 10 },
};

/** pass = executable route within the impact cap · skip = no route / too thin / honeypot · unchecked = couldn't ask (not configured, API down, unsupported chain). */
export type LiquidityStatus = "pass" | "skip" | "unchecked";

export interface LiquidityCheck {
  status: LiquidityStatus;
  level: LiquidityLevel;
  amountUsd: number;
  maxImpactPercent: number;
  /** Absolute price impact of the test swap, when OKX returned a route. */
  impactPercent: number | null;
  reason: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // spec: cache per token address for 5 minutes
const UNCHECKED_TTL_MS = 30 * 1000; // missing config: re-read after a while
const TIMEOUT_MS = 5_000;
const QUOTE_PATH = "/api/v6/dex/aggregator/quote";

interface OkxConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  projectId: string;
  baseUrl: string;
}

function okxConfig(): OkxConfig | null {
  const apiKey = process.env.OKX_API_KEY ?? "";
  const secretKey = process.env.OKX_SECRET_KEY ?? "";
  const passphrase = process.env.OKX_API_PASSPHRASE ?? "";
  if (!apiKey || !secretKey || !passphrase) return null;
  return {
    apiKey,
    secretKey,
    passphrase,
    projectId: process.env.OKX_PROJECT_ID ?? "",
    baseUrl: (process.env.OKX_API_BASE_URL ?? "https://web3.okx.com").replace(/\/$/, ""),
  };
}

export function isOkxConfigured(): boolean {
  return okxConfig() !== null;
}

/** OK-ACCESS-SIGN: base64(HMAC-SHA256(secret, timestamp + method + path + query)). */
export function signOkxRequest(secretKey: string, timestamp: string, method: string, pathWithQuery: string): string {
  return createHmac("sha256", secretKey).update(timestamp + method + pathWithQuery).digest("base64");
}

interface QuoteResponse {
  code?: string;
  msg?: string;
  data?: Array<{
    toTokenAmount?: string;
    priceImpactPercent?: string;
    /** v5 name of the same field. */
    priceImpactPercentage?: string;
    toToken?: { isHoneyPot?: boolean; tokenSymbol?: string };
  }>;
}

/**
 * Turns an OKX quote response into a verdict. Routing failures (no route,
 * not enough liquidity, unsupported token — OKX's 82xxx codes) are a SKIP;
 * auth, rate-limit and system errors (5xxxx) say nothing about the token and
 * are UNCHECKED.
 */
export function verdictFromQuote(
  body: QuoteResponse,
  level: LiquidityLevel,
): Pick<LiquidityCheck, "status" | "impactPercent" | "reason"> {
  const { maxImpactPercent } = LIQUIDITY_LEVELS[level];
  if (body.code !== "0") {
    const code = String(body.code ?? "?");
    const routing = code.startsWith("82") || /liquidity|route|not support|no quote/i.test(body.msg ?? "");
    return { status: routing ? "skip" : "unchecked", impactPercent: null, reason: `OKX ${code}: ${body.msg ?? "error"}` };
  }
  const quote = body.data?.[0];
  if (!quote || !quote.toTokenAmount || BigInt(quote.toTokenAmount) === 0n) {
    return { status: "skip", impactPercent: null, reason: "no route" };
  }
  if (quote.toToken?.isHoneyPot) return { status: "skip", impactPercent: null, reason: "honeypot" };
  const impact = Math.abs(Number(quote.priceImpactPercent ?? quote.priceImpactPercentage));
  if (!Number.isFinite(impact)) return { status: "unchecked", impactPercent: null, reason: "no price impact in quote" };
  return impact <= maxImpactPercent
    ? { status: "pass", impactPercent: impact, reason: `impact ${impact}%` }
    : { status: "skip", impactPercent: impact, reason: `impact ${impact}% > ${maxImpactPercent}%` };
}

const cache = new Map<string, { at: number; check: LiquidityCheck }>();
let requestsSent = 0;

/** Test-only visibility into how many quotes actually went out (cache hits don't count). */
export function okxRequestsSent(): number {
  return requestsSent;
}

export function clearLiquidityCache(): void {
  cache.clear();
}

// OKX rate-limits DEX API keys (code 50011): requests go out one at a time,
// OKX_MIN_INTERVAL_MS apart, and a 50011 is waited out and retried.
let nextSlot = 0;
async function takeSlot(): Promise<void> {
  const interval = Number(process.env.OKX_MIN_INTERVAL_MS ?? 1100);
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + interval;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
const RATE_LIMIT_RETRIES = 3;

async function requestQuote(config: OkxConfig, params: Record<string, string>): Promise<QuoteResponse> {
  for (let attempt = 0; ; attempt++) {
    await takeSlot();
    const body = await requestQuoteOnce(config, params);
    if (body.code !== "50011" || attempt >= RATE_LIMIT_RETRIES) return body;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function requestQuoteOnce(config: OkxConfig, params: Record<string, string>): Promise<QuoteResponse> {
  const query = "?" + new URLSearchParams(params).toString();
  const timestamp = new Date().toISOString();
  requestsSent++;
  const response = await fetch(`${config.baseUrl}${QUOTE_PATH}${query}`, {
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": config.apiKey,
      "OK-ACCESS-SIGN": signOkxRequest(config.secretKey, timestamp, "GET", QUOTE_PATH + query),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": config.passphrase,
      ...(config.projectId ? { "OK-ACCESS-PROJECT": config.projectId } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as QuoteResponse;
  if (!response.ok && body.code === undefined) {
    return { code: `http-${response.status}`, msg: response.statusText };
  }
  return body;
}

/**
 * Test swap of `amountUsd` of the network's stablecoin into `token`; cached
 * per (network, token, level) for 5 minutes.
 */
export async function checkLiquidity(network: NetworkKey, token: string, level: LiquidityLevel): Promise<LiquidityCheck> {
  const { amountUsd, maxImpactPercent } = LIQUIDITY_LEVELS[level];
  const base = { level, amountUsd, maxImpactPercent };
  const key = `${network}:${token.toLowerCase()}:${level}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.check.status === "unchecked" ? UNCHECKED_TTL_MS : CACHE_TTL_MS)) {
    return cached.check;
  }

  const config = okxConfig();
  const quoteToken = quoteTokenFor(network);
  let check: LiquidityCheck;
  // An API hiccup (5xxxx, timeout) is not cached at all, so a retry asks again.
  let transient = false;
  if (!config) {
    check = { ...base, status: "unchecked", impactPercent: null, reason: "OKX API not configured" };
  } else if (!quoteToken) {
    check = { ...base, status: "unchecked", impactPercent: null, reason: `no quote token for ${network}` };
  } else if (token.toLowerCase() === quoteToken.address) {
    check = { ...base, status: "pass", impactPercent: 0, reason: "is the quote token" };
  } else {
    try {
      const body = await requestQuote(config, {
        chainIndex: String(getNetwork(network).chain.id),
        fromTokenAddress: quoteToken.address,
        toTokenAddress: token.toLowerCase(),
        amount: (BigInt(amountUsd) * 10n ** BigInt(quoteToken.decimals)).toString(),
        swapMode: "exactIn",
        slippagePercent: "1",
      });
      check = { ...base, ...verdictFromQuote(body, level) };
      transient = check.status === "unchecked";
    } catch (err) {
      transient = true;
      logger.warn({ err, network, token }, "OKX quote request failed");
      check = { ...base, status: "unchecked", impactPercent: null, reason: `OKX request failed: ${(err as Error).message}` };
    }
  }
  if (!transient) cache.set(key, { at: Date.now(), check });
  return check;
}

/**
 * Both levels for a token. LOW_CAP ($300 / 10%) is asked first: if even that
 * fails, the $1,000 / 5% test can't pass either, so it isn't sent.
 */
export async function checkLiquidityLevels(
  network: NetworkKey,
  token: string,
): Promise<Record<LiquidityLevel, LiquidityCheck>> {
  const lowCap = await checkLiquidity(network, token, "LOW_CAP");
  const strict =
    lowCap.status === "skip"
      ? { ...lowCap, level: "STRICT" as const, ...LIQUIDITY_LEVELS.STRICT, reason: `${lowCap.reason} (at $300)` }
      : await checkLiquidity(network, token, "STRICT");
  return { STRICT: strict, LOW_CAP: lowCap };
}

/**
 * Health probe for /status: $1,000 of the stablecoin into the native coin
 * should always route with ~0 impact; anything else means a bad key, a wrong
 * quote-token address, or a chain OKX doesn't support.
 */
export async function okxHealth(network: NetworkKey): Promise<{ ok: boolean; detail: string }> {
  const check = await checkLiquidity(network, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "STRICT");
  return { ok: check.status === "pass", detail: check.reason };
}

const HEALTH_TTL_MS = 10 * 60 * 1000;
const health = new Map<NetworkKey, { at: number; value: { ok: boolean; detail: string } }>();
const healthInFlight = new Set<NetworkKey>();

/**
 * Last known OKX health for a network without waiting on OKX: /status must
 * not fire a burst of quotes (12 networks at once tripped the rate limit).
 * Returns null while the first check is still running; stale entries are
 * refreshed in the background, one network at a time through the limiter.
 */
export function okxHealthSnapshot(network: NetworkKey): { ok: boolean; detail: string } | null {
  const cached = health.get(network);
  if ((!cached || Date.now() - cached.at > HEALTH_TTL_MS) && !healthInFlight.has(network)) {
    healthInFlight.add(network);
    okxHealth(network)
      .catch((err: Error) => ({ ok: false, detail: err.message }))
      .then((value) => health.set(network, { at: Date.now(), value }))
      .finally(() => healthInFlight.delete(network));
  }
  return cached?.value ?? null;
}
