import { env } from "./env.js";
import { isOkxConfigured } from "../liquidity/okxLiquidity.js";

export type AutoMode = "on" | "off" | "paused-no-okx";

/**
 * Auto-discovery reads and traces every block — the bulk of the RPC bill.
 * Without OKX keys (and with liquidity required, the default) none of its
 * alerts may go out, so it isn't run at all until the keys are set.
 */
export function autoDiscoveryMode(): AutoMode {
  if (!env.AUTO_DISCOVERY) return "off";
  if (env.AUTO_REQUIRE_LIQUIDITY && !isOkxConfigured()) return "paused-no-okx";
  return "on";
}
