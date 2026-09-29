import type { Language } from "../types/index.js";
import type { ListingBatch, RwaListing } from "../rwa/listings.js";
import { getNetwork } from "../config/networks.js";
import { escapeMd } from "./notificationFormatter.js";
import { t } from "./i18n/index.js";

/** Tokens listed by name in a digest; the rest are counted. Keeps it well under Telegram's 4,096 characters. */
const DIGEST_MAX_LINES = 20;

const shorten = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

function tokenWords(lang: Language, listing: RwaListing): string {
  const symbol = `*${escapeMd(listing.symbol)}*`;
  return listing.name ? `${symbol} — ${escapeMd(listing.name)}` : symbol;
}

/**
 * A new token from an RWA custodian (MarkdownV2): one card for a lone
 * listing, a digest naming up to 20 tokens when the issuer launched a batch.
 */
export function formatListingAlert(batch: ListingBatch, lang: Language): string {
  const network = getNetwork(batch.network);
  const issuer = escapeMd(batch.issuer);

  if (batch.listings.length === 1) {
    const listing = batch.listings[0]!;
    return [
      `🆕 *${escapeMd(t(lang, "listing.title"))}* · ${issuer}`,
      "",
      `📍 ${escapeMd(t(lang, "listing.network"))}: ${escapeMd(network.label)}`,
      `🏷 ${escapeMd(t(lang, "listing.token"))}: ${tokenWords(lang, listing)}`,
      `🏦 ${escapeMd(t(lang, "listing.issuer"))}: ${issuer}`,
      "",
      `📄 ${escapeMd(t(lang, "listing.contract"))}:`,
      escapeMd(listing.address),
      "",
      `🔗 ${escapeMd(t(lang, "listing.links"))}`,
      [
        `[Block Explorer](${network.explorerAddressUrl(listing.address)})`,
        `[DexScreener](${network.dexscreenerTokenUrl(listing.address)})`,
      ].join(" \\| "),
    ].join("\n");
  }

  const shown = batch.listings.slice(0, DIGEST_MAX_LINES);
  const hidden = batch.listings.length - shown.length;
  return [
    `🆕 *${escapeMd(t(lang, "listing.digestTitle", { issuer: batch.issuer, count: String(batch.listings.length) }))}*`,
    `📍 ${escapeMd(t(lang, "listing.network"))}: ${escapeMd(network.label)}`,
    "",
    ...shown.map(
      (listing) => `• ${tokenWords(lang, listing)} · [${escapeMd(shorten(listing.address))}](${network.explorerAddressUrl(listing.address)})`,
    ),
    ...(hidden > 0 ? [`_${escapeMd(t(lang, "listing.digestMore", { count: String(hidden) }))}_`] : []),
  ].join("\n");
}
