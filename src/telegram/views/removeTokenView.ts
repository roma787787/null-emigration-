import { Markup } from "telegraf";
import type { TokenRecord } from "../../types/index.js";

export function buildRemoveConfirmView(
  tokens: TokenRecord[],
  address: `0x${string}`,
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const lines = tokens.map((t) => `  • ${t.symbol ?? "?"} on ${t.network}`);
  const text = [
    `Remove ${address} from tracking? This also drops its discovered owners and any migration contracts found for it.`,
    "",
    ...lines,
  ].join("\n");

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Confirm", `remove:confirm:${address}`),
      Markup.button.callback("✖️ Cancel", "remove:cancel"),
    ],
  ]);

  return { text, keyboard };
}
