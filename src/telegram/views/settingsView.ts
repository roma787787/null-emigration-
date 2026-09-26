import { Markup } from "telegraf";
import { allNetworkKeys } from "../../config/networks.js";
import { chatSettingsRepository } from "../../db/repositories/chatSettingsRepository.js";
import type { ChatSettingsRecord, NetworkKey } from "../../types/index.js";

const NETWORK_BUTTONS_PER_ROW = 3;

function checkmark(active: boolean): string {
  return active ? " ✅" : "";
}

export function buildSettingsText(settings: ChatSettingsRecord): string {
  return [
    "⚙️ Settings",
    "",
    `Confidence filter: ${settings.confidenceFilter}`,
    `Networks: ${settings.networksFilter ? settings.networksFilter.join(", ") : "all"}`,
  ].join("\n");
}

export function buildSettingsKeyboard(settings: ChatSettingsRecord): ReturnType<typeof Markup.inlineKeyboard> {
  const confidenceRow = [
    Markup.button.callback(`All confidence${checkmark(settings.confidenceFilter === "ALL")}`, "settings:confidence:ALL"),
    Markup.button.callback(
      `HIGH only${checkmark(settings.confidenceFilter === "HIGH_ONLY")}`,
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
    Markup.button.callback(`All networks${checkmark(settings.networksFilter === null)}`, "settings:net:ALL"),
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
  return { text: buildSettingsText(settings), keyboard: buildSettingsKeyboard(settings) };
}
