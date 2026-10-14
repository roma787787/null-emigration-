import type { MigrationContractRecord, NetworkKey } from "../types/index.js";
import { migrationContractRepository } from "../db/repositories/migrationContractRepository.js";
import { termsFor } from "../analyzer/migrationTerms.js";
import { logger } from "../utils/logger.js";

/**
 * "The trade turned profitable": every alerted migration of the last
 * `days` is re-priced on a timer — buy the old token with $300, migrate at
 * the contract's rate, sell the new one, all on OKX quotes — and a card goes
 * out when the result reaches `thresholdPercent`. The point of the bot is
 * not "a migration exists" but "it pays now", and that moment usually comes
 * after the first alert, once the new token's market fills in.
 *
 * Once per climb: again only `stepPercent` higher than the last alert, or
 * after the trade has fallen back to a loss and turned profitable anew.
 */

export interface ProfitWatchOptions {
  intervalMs?: number;
  days?: number;
  thresholdPercent?: number;
  stepPercent?: number;
}

export function profitWatchOptionsFromEnv(): ProfitWatchOptions {
  const num = (name: string) => {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) ? v : undefined;
  };
  return {
    intervalMs: num("PROFIT_WATCH_INTERVAL_MS"),
    days: num("PROFIT_WATCH_DAYS"),
    thresholdPercent: num("PROFIT_ALERT_PERCENT"),
    stepPercent: num("PROFIT_ALERT_STEP"),
  };
}

/** What to do with a fresh trade result, given the last alerted one. */
export function profitDecision(
  percent: number | null,
  lastAlerted: number | null,
  threshold: number,
  step: number,
): "alert" | "reset" | "none" {
  if (percent === null) return "none";
  if (percent >= threshold && (lastAlerted === null || percent >= lastAlerted + step)) return "alert";
  if (percent < 0 && lastAlerted !== null) return "reset";
  return "none";
}

/** One pass: re-price every watched migration of the network, alerting the ones that turned profitable. */
export async function pollProfits(
  network: NetworkKey,
  onProfitable: (record: MigrationContractRecord, percent: number) => Promise<void>,
  options: ProfitWatchOptions = {},
): Promise<void> {
  const days = options.days ?? 30;
  const threshold = options.thresholdPercent ?? 5;
  const step = options.stepPercent ?? 10;
  const watched = await migrationContractRepository.listProfitWatch(network, days);
  for (const record of watched) {
    try {
      const terms = await termsFor(network, record.contractAddress, record.tokenAAddress, record.tokenBAddress, undefined, {
        creator: record.creatorAddress,
        keep: record.terms,
        observedTx: record.openedTx ?? null,
      });
      if (!terms) continue;
      await migrationContractRepository.setTerms(record.id, terms);
      const trip = terms.prices?.roundTrip;
      const percent = trip && trip.outUsd !== null && trip.percent !== null ? trip.percent : null;
      const last = record.profitAlertPercent ?? null;
      const decision = profitDecision(percent, last, threshold, step);
      if (decision === "reset") await migrationContractRepository.resetProfitAlert(record.id);
      if (decision !== "alert" || percent === null) continue;
      if (!(await migrationContractRepository.markProfitAlerted(record.id, percent, last))) continue;
      logger.info({ network, contract: record.contractAddress, percent }, "Migration trade turned profitable");
      await onProfitable({ ...record, terms, profitAlertPercent: percent }, percent);
    } catch (err) {
      logger.warn({ err, network, contract: record.contractAddress }, "Profit watch: re-pricing failed");
    }
  }
}

/** Re-prices a network's alerted migrations every `intervalMs` (default an hour). Returns a stopper. */
export function startProfitWatcher(
  network: NetworkKey,
  onProfitable: (record: MigrationContractRecord, percent: number) => Promise<void>,
  options: ProfitWatchOptions = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 3_600_000;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    running = pollProfits(network, onProfitable, options).catch((err) => {
      logger.warn({ err, network }, "Profit watch pass failed");
    });
    await running;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  // First pass a little after start: the block feeds and OKX health checks go first.
  let timer = setTimeout(tick, Math.min(intervalMs, 120_000));
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
