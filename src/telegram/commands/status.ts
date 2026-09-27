import type { Telegraf } from "telegraf";
import type { Language, NetworkKey } from "../../types/index.js";
import { enabledNetworks } from "../../config/networks.js";
import { env } from "../../config/env.js";
import { getPublicClient } from "../../chain/provider.js";
import { getListenerStatus, type ListenerStatus } from "../../chain/listenerStatus.js";
import { traceDetectionStatus } from "../../chain/traceCreateDetector.js";
import { statsRepository } from "../../db/repositories/statsRepository.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { getContractCreationQueue } from "../../queue/notificationQueue.js";
import { isAdminChat } from "../accessControl.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

const HEAD_TIMEOUT_MS = 4_000;
const HEALTHY_WITHIN_MS = 2 * 60 * 1000;
const STALE_WITHIN_MS = 10 * 60 * 1000;

export interface NetworkReport {
  network: NetworkKey;
  listener: ListenerStatus | undefined;
  head: bigint | null;
  trace: "on" | "unavailable" | "off";
}

export interface StatusReport {
  uptimeSec: number;
  counts: { tokens: number; owners: number; contracts: number };
  queue: { waiting: number; active: number; delayed: number; failed: number };
  networks: NetworkReport[];
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ${min % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function networkLine(lang: Language, report: NetworkReport, now: number): string {
  const { listener } = report;
  if (!listener) return `🔴 ${report.network} · ${t(lang, "status.notStarted")}`;

  const sinceLast = listener.lastProcessedAt ? now - listener.lastProcessedAt.getTime() : Infinity;
  const icon = sinceLast <= HEALTHY_WITHIN_MS ? "🟢" : sinceLast <= STALE_WITHIN_MS ? "🟡" : "🔴";
  const parts = [`${icon} ${report.network}`, listener.mode];

  if (listener.lastProcessedBlock === null || !listener.lastProcessedAt) {
    parts.push(t(lang, "status.noBlocks"));
  } else {
    parts.push(t(lang, "status.block", { block: listener.lastProcessedBlock.toString() }));
    parts.push(
      report.head === null
        ? t(lang, "status.headUnknown")
        : t(lang, "status.lag", { lag: (report.head > listener.lastProcessedBlock ? report.head - listener.lastProcessedBlock : 0n).toString() }),
    );
    parts.push(t(lang, "status.ago", { ago: formatDuration(sinceLast) }));
  }
  const traceState = { on: "status.traceOn", unavailable: "status.traceUnavailable", off: "status.traceOff" }[report.trace];
  parts.push(t(lang, "status.trace", { state: t(lang, traceState) }));

  const extra: string[] = [];
  if (listener.skippedBlocks > 0) extra.push(t(lang, "status.skipped", { count: listener.skippedBlocks }));
  if (listener.failedBlocks > 0) extra.push(t(lang, "status.failedBlocks", { count: listener.failedBlocks }));
  if (listener.lastError && listener.lastErrorAt) {
    extra.push(
      t(lang, "status.lastError", {
        ago: formatDuration(now - listener.lastErrorAt.getTime()),
        error: listener.lastError.split("\n")[0]!.slice(0, 160),
      }),
    );
  }
  return [parts.join(" · "), ...extra.map((e) => `    ↳ ${e}`)].join("\n");
}

export function formatStatus(lang: Language, report: StatusReport, now = Date.now()): string {
  const lines = [
    t(lang, "status.title"),
    "",
    t(lang, "status.uptime", { uptime: formatDuration(report.uptimeSec * 1000) }),
    t(lang, "status.counts", report.counts),
    t(lang, "status.queue", report.queue),
    "",
    t(lang, "status.networks"),
  ];
  if (report.networks.length === 0) lines.push(t(lang, "status.none"));
  for (const network of report.networks) lines.push(networkLine(lang, network, now));
  return lines.join("\n");
}

async function chainHead(network: NetworkKey): Promise<bigint | null> {
  try {
    return await Promise.race([
      getPublicClient(network).getBlockNumber({ cacheTime: 0 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), HEAD_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

export async function collectStatus(): Promise<StatusReport> {
  const [counts, jobCounts, networks] = await Promise.all([
    statsRepository.counts(),
    getContractCreationQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    Promise.all(
      enabledNetworks().map(async (network): Promise<NetworkReport> => ({
        network,
        listener: getListenerStatus(network),
        head: await chainHead(network),
        trace: env.ENABLE_FACTORY_TRACE_DETECTION ? traceDetectionStatus(network) : "off",
      })),
    ),
  ]);
  return {
    uptimeSec: process.uptime(),
    counts,
    queue: {
      waiting: jobCounts.waiting ?? 0,
      active: jobCounts.active ?? 0,
      delayed: jobCounts.delayed ?? 0,
      failed: jobCounts.failed ?? 0,
    },
    networks,
  };
}

/** /status — admin-only health overview: per-network listener progress, lag and errors. */
export function registerStatusCommand(bot: Telegraf): void {
  bot.command("status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const settings = await chatSettingsRepository.ensure(chatId);
    const lang = settings.language ?? DEFAULT_LANGUAGE;
    if (!isAdminChat(chatId)) {
      await ctx.reply(t(lang, "status.adminOnly"));
      return;
    }
    await ctx.reply(formatStatus(lang, await collectStatus()), { link_preview_options: { is_disabled: true } });
  });
}
