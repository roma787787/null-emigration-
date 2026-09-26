import { Markup } from "telegraf";
import { tokenRepository } from "../../db/repositories/tokenRepository.js";
import { ownerRepository } from "../../db/repositories/ownerRepository.js";
import type { Language } from "../../types/index.js";
import { t } from "../i18n/index.js";

const PAGE_SIZE = 5;

export async function renderListPage(
  page: number,
  lang: Language,
): Promise<{
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}> {
  const tokens = await tokenRepository.listAll();

  if (tokens.length === 0) {
    return {
      text: t(lang, "list.empty"),
      keyboard: Markup.inlineKeyboard([]),
    };
  }

  const pageCount = Math.ceil(tokens.length / PAGE_SIZE);
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageTokens = tokens.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const blocks = await Promise.all(
    pageTokens.map(async (token) => {
      const owners = await ownerRepository.listForToken(token.id);
      const ownerLines =
        owners.length > 0 ? owners.map((o) => `    • ${o.address} (${o.source})`).join("\n") : t(lang, "list.ownersNone");
      return [`🪙 ${token.symbol ?? "?"} — ${token.network} — ${token.address}`, t(lang, "list.ownersLabel"), ownerLines].join(
        "\n",
      );
    }),
  );

  const text = [t(lang, "list.header", { page: safePage + 1, pageCount }), "", blocks.join("\n\n")].join("\n");

  const navRow = [];
  if (safePage > 0) navRow.push(Markup.button.callback(t(lang, "list.prevButton"), `list:page:${safePage - 1}`));
  if (safePage < pageCount - 1)
    navRow.push(Markup.button.callback(t(lang, "list.nextButton"), `list:page:${safePage + 1}`));

  return { text, keyboard: Markup.inlineKeyboard(navRow.length > 0 ? [navRow] : []) };
}
