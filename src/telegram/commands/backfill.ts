import type { Telegraf } from "telegraf";
import type { Language, NetworkKey } from "../../types/index.js";
import { isKnownNetwork } from "../../config/networks.js";
import { getPublicClient } from "../../chain/provider.js";
import { backfillCsv, blockAtTime, decisionCounts, runBackfill, type BackfillReport } from "../../backfill/backfill.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import { isAdminChat } from "../accessControl.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";
import { logger } from "../../utils/logger.js";

const MAX_DAYS = 31;
const ALERTS_LISTED = 15;

/** "7d" → 7 days, "12h" → 12 hours, "5000" → the last 5,000 blocks. */
export function parseBackfillRange(value: string): { seconds: number } | { blocks: number } | null {
  const match = /^(\d+)([dh]?)$/i.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!(n > 0)) return null;
  const unit = match[2]!.toLowerCase();
  if (unit === "d") return n <= MAX_DAYS ? { seconds: n * 86_400 } : null;
  if (unit === "h") return n <= MAX_DAYS * 24 ? { seconds: n * 3_600 } : null;
  return { blocks: n };
}

let running: { network: NetworkKey; controller: AbortController; done: number; total: number } | null = null;

function blocksPerSec(): number {
  const value = Number(process.env.BACKFILL_BLOCKS_PER_SEC);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

function parallelBlocks(): number {
  const value = Number(process.env.BACKFILL_PARALLEL_BLOCKS);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 50) : 8;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function formatBackfillSummary(lang: Language, report: BackfillReport): string {
  const counts = decisionCounts(report);
  const reasons = Object.entries(report.skipped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(" · ");
  const alerts = report.candidates.filter((c) => c.decision === "alert");
  const lines = [
    t(lang, report.stopped ? "backfill.doneStopped" : "backfill.done", {
      network: report.network,
      from: report.fromBlock.toString(),
      to: report.toBlock.toString(),
      scanned: report.blocksScanned,
      failed: report.blocksFailed,
    }),
    t(lang, "backfill.contracts", { contracts: report.contracts, errors: report.analysisErrors }),
    t(lang, "backfill.decisions", {
      alert: counts.alert,
      liquidity: counts.liquidity,
      swap: counts["swap-bot"],
      stable: counts.stablecoin,
      unchecked: counts.unchecked,
      duplicate: counts.duplicate,
    }),
    t(lang, "backfill.reasons", { reasons: reasons || "—" }),
  ];
  if (alerts.length > 0) {
    lines.push("", t(lang, "backfill.alertsHeader"));
    for (const c of alerts.slice(0, ALERTS_LISTED)) {
      const strict = c.liquidity?.STRICT;
      const market = !c.liquidity ? c.custodianLabel ?? "" : strict?.status === "pass" ? `Strict ✅ ${strict.impactPercent?.toFixed(2)}%` : "Low-Cap ✅";
      const target = c.tokenBAddress ? short(c.tokenBAddress) : c.tokenBSymbolUnverified ?? "?";
      lines.push(`• ${c.contractAddress} · ${c.tokenASymbol ?? short(c.tokenAAddress)} → ${target} · ${c.confidence} ${c.confidenceScore}% · ${market}`);
    }
    if (alerts.length > ALERTS_LISTED) lines.push(t(lang, "backfill.more", { count: alerts.length - ALERTS_LISTED }));
  }
  lines.push("", t(lang, "backfill.fileNote"));
  return lines.join("\n");
}

/**
 * /backfill <network> <range> — admin only: runs past blocks through the
 * live pipeline in the background and sends a summary plus a CSV of every
 * candidate. Nothing reaches the other chats. /backfill_stop stops it.
 */
export function registerBackfillCommands(bot: Telegraf): void {
  bot.command("backfill", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const lang = (await chatSettingsRepository.ensure(chatId)).language ?? DEFAULT_LANGUAGE;
    if (!isAdminChat(chatId)) return void (await ctx.reply(t(lang, "status.adminOnly")));

    const [networkArg, rangeArg] = ctx.message.text.split(/\s+/).slice(1);
    if (running) {
      return void (await ctx.reply(t(lang, "backfill.busy", { network: running.network, done: running.done, total: running.total })));
    }
    const range = rangeArg ? parseBackfillRange(rangeArg) : null;
    if (!networkArg || !range) return void (await ctx.reply(t(lang, "backfill.usage")));
    const network = networkArg.toLowerCase();
    if (!isKnownNetwork(network)) return void (await ctx.reply(t(lang, "backfill.unknownNetwork", { network })));

    let fromBlock: bigint;
    let toBlock: bigint;
    try {
      toBlock = await getPublicClient(network).getBlockNumber({ cacheTime: 0 });
      fromBlock =
        "blocks" in range
          ? (toBlock - BigInt(range.blocks) + 1n > 0n ? toBlock - BigInt(range.blocks) + 1n : 0n)
          : await blockAtTime(network, Math.floor(Date.now() / 1000) - range.seconds);
    } catch (err) {
      logger.warn({ err, network }, "Backfill: could not resolve the block range");
      return void (await ctx.reply(t(lang, "backfill.rpcError", { network })));
    }

    const total = Number(toBlock - fromBlock + 1n);
    const speed = blocksPerSec();
    const controller = new AbortController();
    running = { network, controller, done: 0, total };
    await ctx.reply(
      t(lang, "backfill.started", {
        network,
        from: fromBlock.toString(),
        to: toBlock.toString(),
        total,
        hours: (total / speed / 3600).toFixed(1),
        speed,
      }),
    );

    const telegram = ctx.telegram;
    void runBackfill({
      network,
      fromBlock,
      toBlock,
      blocksPerSec: speed,
      parallelBlocks: parallelBlocks(),
      signal: controller.signal,
      onProgress: async ({ done, report }) => {
        if (running) running.done = done;
        await telegram
          .sendMessage(
            chatId,
            t(lang, "backfill.progress", {
              network,
              pct: Math.round((done / total) * 100),
              done,
              total,
              contracts: report.contracts,
              candidates: report.candidates.length,
            }),
          )
          .catch(() => undefined);
      },
    })
      .then(async (report) => {
        await telegram.sendMessage(chatId, formatBackfillSummary(lang, report), { link_preview_options: { is_disabled: true } });
        await telegram.sendDocument(chatId, {
          source: Buffer.from(backfillCsv(report)),
          filename: `backfill-${network}-${report.fromBlock}-${report.toBlock}.csv`,
        });
      })
      .catch(async (err) => {
        logger.error({ err, network }, "Backfill failed");
        await telegram.sendMessage(chatId, t(lang, "backfill.failed", { network, error: String((err as Error).message ?? err).slice(0, 200) })).catch(() => undefined);
      })
      .finally(() => {
        running = null;
      });
  });

  bot.command("backfill_stop", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const lang = (await chatSettingsRepository.ensure(chatId)).language ?? DEFAULT_LANGUAGE;
    if (!isAdminChat(chatId)) return void (await ctx.reply(t(lang, "status.adminOnly")));
    if (!running) return void (await ctx.reply(t(lang, "backfill.none")));
    running.controller.abort();
    await ctx.reply(t(lang, "backfill.stopping"));
  });
}
