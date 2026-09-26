import { Markup } from "telegraf";
import { allNetworkKeys } from "../../config/networks.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import type { ChatSettingsRecord, Language, NetworkKey } from "../../types/index.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

const NETWORK_BUTTONS_PER_ROW = 3;

function checkmark(active: boolean): string {
  return active ? " ✅" : "";
}

export function buildSettingsText(settings: ChatSettingsRecord, lang: Language): string {
  return [
    t(lang, "settings.title"),
    "",
    t(lang, "settings.confidenceLabel", { filter: settings.confidenceFilter }),
    t(lang, "settings.networksLabel", {
      networks: settings.networksFilter ? settings.networksFilter.join(", ") : t(lang, "settings.networksAll"),
    }),
  ].join("\n");
}

export function buildSettingsKeyboard(
  settings: ChatSettingsRecord,
  lang: Language,
): ReturnType<typeof Markup.inlineKeyboard> {
  const confidenceRow = [
    Markup.button.callback(
      `${t(lang, "settings.buttonAllConfidence")}${checkmark(settings.confidenceFilter === "ALL")}`,
      "settings:confidence:ALL",
    ),
    Markup.button.callback(
      `${t(lang, "settings.buttonHighOnly")}${checkmark(settings.confidenceFilter === "HIGH_ONLY")}`,
      "settings:confidence:HIGH_ONLY",
    ),
  ];

  const networks = allNetworkKeys();
  const networkRows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < networks.length; i += NETWORK_BUTTONS_PER_ROW) {
    const chunk = networks.slice(i, i + NETWORK_BUTTONS_PER_ROW);
    networkRows.push(
      chunk.map((network) =>
        Markup.button.callback(
          `${network}${checkmark(isNetworkActive(settings.networksFilter, network))}`,
          `settings:net:${network}`,
        ),
      ),
    );
  }

  const allNetworksRow = [
    Markup.button.callback(
      `${t(lang, "settings.buttonAllNetworks")}${checkmark(settings.networksFilter === null)}`,
      "settings:net:ALL",
    ),
  ];

  return Markup.inlineKeyboard([confidenceRow, ...networkRows, allNetworksRow]);
}

function isNetworkActive(filter: NetworkKey[] | null, network: NetworkKey): boolean {
  return filter === null || filter.includes(network);
}

/**
 * Toggles one network's membership in the chat's allow-list. `null` means
 * "all networks" (every button renders checked); toggling one off from that
 * state materializes the implicit full list minus that network. Toggling
 * back in the last missing network collapses back to `null`.
 */
export function toggleNetworkFilter(current: NetworkKey[] | null, network: NetworkKey): NetworkKey[] | null {
  const universe = allNetworkKeys();
  const active = new Set(current ?? universe);

  if (active.has(network)) {
    active.delete(network);
  } else {
    active.add(network);
  }

  if (active.size === universe.length) return null;
  return universe.filter((n) => active.has(n));
}

export async function renderSettings(chatId: string): Promise<{
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}> {
  const settings = await chatSettingsRepository.ensure(chatId);
  const lang = settings.language ?? DEFAULT_LANGUAGE;
  return { text: buildSettingsText(settings, lang), keyboard: buildSettingsKeyboard(settings, lang) };
}
