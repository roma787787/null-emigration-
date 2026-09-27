import type { Language } from "../../types/index.js";
import { t } from "../i18n/index.js";

/** Most wallets listed per token; the rest collapse into "… and N more". */
export const MAX_OWNER_LINES = 8;

/**
 * Wallet lines for a token. Capped so a token with many admins (e.g. a large
 * DEFAULT_ADMIN_ROLE) can't push a message past Telegram's 4096-char limit,
 * which would make Telegram reject the whole reply.
 */
export function formatOwnerLines(
  owners: Array<{ address: string; source: string }>,
  lang: Language,
  indent: string,
  max = MAX_OWNER_LINES,
): string {
  const lines = owners.slice(0, max).map((o) => `${indent}• ${o.address} (${o.source})`);
  if (owners.length > max) lines.push(`${indent}${t(lang, "owners.more", { count: owners.length - max })}`);
  return lines.join("\n");
}
