import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const BATCH_SIZE = 50;
const TIMEOUT_MS = 3_000;
const MAX_CACHE_ENTRIES = 50_000;

// A selector's text signature never changes, so hits (and confirmed misses,
// stored as null) are cached for the process lifetime.
const cache = new Map<string, string | null>();

interface LookupResponse {
  ok?: boolean;
  result?: { function?: Record<string, Array<{ name?: string; filtered?: boolean }> | null> };
}

/** Picks the best signature from a lookup response entry (first non-spam one). */
export function pickSignature(entries: Array<{ name?: string; filtered?: boolean }> | null | undefined): string | null {
  if (!entries) return null;
  const usable = entries.filter((e) => typeof e.name === "string" && !e.filtered);
  return usable[0]?.name ?? null;
}

async function fetchBatch(selectors: string[]): Promise<Record<string, string | null>> {
  const url = new URL(env.SIGNATURE_DB_URL);
  url.searchParams.set("function", selectors.join(","));
  url.searchParams.set("filter", "true");

  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`signature DB responded ${response.status}`);
  const body = (await response.json()) as LookupResponse;

  const out: Record<string, string | null> = {};
  for (const selector of selectors) {
    out[selector] = pickSignature(body.result?.function?.[selector]);
  }
  return out;
}

/**
 * Resolves 4-byte selectors to text signatures (e.g. 0x454b0608 ->
 * "migrate(uint256)") via the public OpenChain-compatible signature
 * database (Sourcify's api.4byte.sourcify.dev). This is how the analyzer
 * recognises project-specific names like migrateFromLEND or mkrToSky without
 * waiting for the contract to be verified. Best-effort: on any failure the
 * affected selectors are simply left unresolved.
 */
export async function lookupFunctionSignatures(selectors: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (env.SIGNATURE_DB_URL === "off") return resolved;

  const wanted = [...new Set(selectors.map((s) => s.toLowerCase()))];
  const missing = wanted.filter((s) => !cache.has(s));

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    try {
      const result = await fetchBatch(batch);
      if (cache.size > MAX_CACHE_ENTRIES) cache.clear();
      for (const selector of batch) cache.set(selector, result[selector] ?? null);
    } catch (err) {
      logger.warn({ err, count: batch.length }, "Signature DB lookup failed; continuing without function names");
      break;
    }
  }

  for (const selector of wanted) {
    const name = cache.get(selector);
    if (name) resolved.set(selector, name);
  }
  return resolved;
}
