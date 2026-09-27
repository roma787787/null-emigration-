import { Markup, type Telegraf, type Context } from "telegraf";
import { env } from "../config/env.js";
import { chatSettingsRepository } from "../db/repositories/chatSettingsRepository.js";
import type { Language } from "../types/index.js";
import { t, languages, languageLabels, DEFAULT_LANGUAGE } from "./i18n/index.js";
import { logger } from "../utils/logger.js";
import { sendWithRetry } from "./send.js";

/** Commands usable before language selection / admin approval. */
const BYPASS_COMMANDS = new Set(["start", "help", "language"]);
const BYPASS_CALLBACK_PREFIXES = ["lang:", "admin:"];

export function isAdminChat(chatId: string): boolean {
  return env.adminChatIds().includes(chatId);
}

function commandNameFromText(text: string | undefined): string | null {
  if (!text || !text.startsWith("/")) return null;
  const first = text.trim().split(/\s+/)[0] ?? "";
  return first.slice(1).split("@")[0]?.toLowerCase() ?? null;
}

function describeChat(ctx: Context): { title: string; username: string } {
  const chat = ctx.chat as { type?: string; title?: string; username?: string; first_name?: string } | undefined;
  const from = ctx.from;
  const title =
    chat?.type === "private"
      ? [chat.first_name, from?.last_name].filter(Boolean).join(" ") || "Private chat"
      : (chat?.title ?? "Unknown chat");
  const username = from?.username ? `@${from.username}` : chat?.username ? `@${chat.username}` : "—";
  return { title, username };
}

function languageKeyboard() {
  return Markup.inlineKeyboard(languages.map((lang) => [Markup.button.callback(languageLabels[lang], `lang:${lang}`)]));
}

async function notifyAdminsOfRequest(bot: Telegraf, ctx: Context, chatId: string, language: Language): Promise<void> {
  const { title, username } = describeChat(ctx);

  for (const adminId of env.adminChatIds()) {
    const adminSettings = await chatSettingsRepository.get(adminId);
    const adminLang = adminSettings?.language ?? DEFAULT_LANGUAGE;

    try {
      await sendWithRetry(
        bot,
        adminId,
        t(adminLang, "approval.adminRequest", { title, chatId, username, language }),
        Markup.inlineKeyboard([
          [
            Markup.button.callback(t(adminLang, "approval.approveButton"), `admin:approve:${chatId}`),
            Markup.button.callback(t(adminLang, "approval.rejectButton"), `admin:reject:${chatId}`),
          ],
        ]),
      );
    } catch (err) {
      logger.warn({ err, adminId, chatId }, "Failed to notify admin of access request (they may not have started the bot)");
    }
  }
}

/**
 * Handles /start (and re-runs of it): shows the language picker on first
 * contact, then either the welcome text (approved/admin chats) or a
 * "waiting for approval" notice — sending the one-time admin request the
 * first time a non-admin chat completes language selection.
 */
async function sendStatus(bot: Telegraf, ctx: Context, chatId: string): Promise<void> {
  const settings = await chatSettingsRepository.ensure(chatId);

  if (settings.language === null) {
    await ctx.reply(t(DEFAULT_LANGUAGE, "lang.prompt") + "\n" + t("uk", "lang.prompt") + "\n" + t("ru", "lang.prompt"), languageKeyboard());
    return;
  }

  const admin = isAdminChat(chatId);
  if (admin && !settings.approved) {
    await chatSettingsRepository.setApproved(chatId, true);
  }

  if (admin || settings.approved) {
    await ctx.reply(t(settings.language, "welcome"));
    return;
  }

  await ctx.reply(t(settings.language, "approval.stillPending"));
  if (!settings.accessRequested) {
    await notifyAdminsOfRequest(bot, ctx, chatId, settings.language);
    await chatSettingsRepository.setAccessRequested(chatId, true);
  }
}

export function registerAccessControl(bot: Telegraf): void {
  // Gate: everything except /start, /help, /language, and lang:*/admin:*
  // callbacks requires the chat to have picked a language and be approved
  // (or be an admin chat).
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat ? String(ctx.chat.id) : ctx.callbackQuery ? String(ctx.callbackQuery.from.id) : null;
    if (!chatId) return next();

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      if (BYPASS_CALLBACK_PREFIXES.some((p) => ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data.startsWith(p))) {
        return next();
      }
    } else {
      const command = commandNameFromText(ctx.message && "text" in ctx.message ? ctx.message.text : undefined);
      if (command && BYPASS_COMMANDS.has(command)) return next();
    }

    if (isAdminChat(chatId)) return next();

    const settings = await chatSettingsRepository.get(chatId);
    const lang = settings?.language ?? DEFAULT_LANGUAGE;

    if (!settings || settings.language === null) {
      await ctx.reply(`${t("en", "approval.blocked")}\n${t("uk", "approval.blocked")}\n${t("ru", "approval.blocked")}`);
      return;
    }
    if (!settings.approved) {
      await ctx.reply(t(lang, "approval.blocked"));
      return;
    }

    return next();
  });

  bot.start(async (ctx) => {
    await sendStatus(bot, ctx, String(ctx.chat.id));
  });

  bot.command("help", async (ctx) => {
    await sendStatus(bot, ctx, String(ctx.chat.id));
  });

  bot.command("language", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await chatSettingsRepository.ensure(chatId);
    await ctx.reply(t(DEFAULT_LANGUAGE, "lang.prompt") + "\n" + t("uk", "lang.prompt") + "\n" + t("ru", "lang.prompt"), languageKeyboard());
  });

  bot.action(/^lang:(en|uk|ru)$/, async (ctx) => {
    const language = ctx.match[1] as Language;
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);

    await chatSettingsRepository.setLanguage(chatId, language);
    await ctx.answerCbQuery(t(language, "lang.chosen"));
    await ctx.editMessageText(t(language, "lang.chosen")).catch(() => undefined);
    await sendStatus(bot, ctx, chatId);
  });

  bot.action(/^admin:(approve|reject):(-?\d+)$/, async (ctx) => {
    const [, action, targetChatId] = ctx.match;
    const actingChatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);

    if (!isAdminChat(actingChatId)) {
      await ctx.answerCbQuery("Not authorized");
      return;
    }

    const targetSettings = await chatSettingsRepository.ensure(targetChatId!);
    const targetLang = targetSettings.language ?? DEFAULT_LANGUAGE;
    // The admin's confirmation is in the admin's language, the notice in the user's.
    const adminLang = (await chatSettingsRepository.get(actingChatId))?.language ?? DEFAULT_LANGUAGE;
    const approve = action === "approve";
    const confirmation = t(adminLang, approve ? "approval.approvedByAdmin" : "approval.rejectedByAdmin", {
      chatId: targetChatId!,
    });

    await chatSettingsRepository.setApproved(targetChatId!, approve);
    await ctx.answerCbQuery(confirmation);
    await ctx.editMessageText(confirmation).catch(() => undefined);
    await sendWithRetry(bot, targetChatId!, t(targetLang, approve ? "approval.granted" : "approval.deniedNotice")).catch(
      () => undefined,
    );
  });
}
