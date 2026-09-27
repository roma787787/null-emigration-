import { Markup } from "telegraf";
import type { Language, TokenRecord } from "../../types/index.js";
import { t } from "../i18n/index.js";

export function buildRemoveConfirmView(
  tokens: TokenRecord[],
  address: `0x${string}`,
  lang: Language,
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const lines = tokens.map((token) => `  • ${token.symbol ?? "?"} — ${token.network}`);
  const text = [t(lang, "removeToken.confirmPrompt", { address }), "", ...lines].join("\n");

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(t(lang, "removeToken.confirmButton"), `remove:confirm:${address}`),
      Markup.button.callback(t(lang, "removeToken.cancelButton"), "remove:cancel"),
    ],
  ]);

  return { text, keyboard };
}
