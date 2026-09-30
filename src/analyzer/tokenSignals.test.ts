import { test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { isErc4626Vault, isMigrationAction } from "./tokenSignals.js";

test("migration actions count; settings, flags, views and ERC-4626 conversions don't", () => {
  for (const sig of [
    "migrate(uint256)", "migrate()", "migrateFromLEND(uint256)", "migrateTokens(uint256)", "convert()", "convertTokens(uint256)",
    "convertOldToNew(uint256)", "migrateAll()",
    // from the Ethereum backfill: Hunt Town's migrator
    "migrate(uint256[],uint256)", "migrateByOperator(uint256,address,bytes32,uint256)",
  ]) {
    assert.equal(isMigrationAction(sig), true, sig);
  }
  for (const sig of [
    "setMigratedPool(address,bool)", "setMigratedPools(address[],bool)", "migratedPools(address)", "migrationEnded()", "migrationStarted()",
    "isConverted(address)", "convertedAmount()", "convertToShares(uint256)", "convertToAssets(uint256)", "_totalLendMigrated()",
  ]) {
    assert.equal(isMigrationAction(sig), false, sig);
  }
});

test("backfill false positives: nouns, constants, views and position moves are not token migrations", () => {
  for (const sig of [
    "converter()", // Ondo TSLAon / TLTon wrappers, UNI and CULT wrappers
    "CONVERT_MAX_BPS()", "CONVERT_MIN()", "convertStep()", // wTAO converter's parameters
    "migrateStake(address,uint256)", // EARN staking
    "migrateLoanParamsList(address,uint256,uint256)", // bZx loans
    "migrateLiquidity(address,uint256)", "migratePosition(uint256)",
    // from the BSC backfill: an account move over BTCB, an admin's funds move
    "migrateAccount(address,address)", "migrateFunds(address)",
  ]) {
    assert.equal(isMigrationAction(sig), false, sig);
  }
});

test("ERC-4626 vaults are recognised by asset/totalAssets + convertTo*, or by both conversions", () => {
  const sel = (...sigs: string[]) => sigs.map((s) => toFunctionSelector(s));
  assert.equal(isErc4626Vault(sel("asset()", "totalAssets()", "convertToShares(uint256)", "convertToAssets(uint256)")), true);
  assert.equal(isErc4626Vault(sel("asset()", "convertToShares(uint256)")), false);
  assert.equal(isErc4626Vault(sel("migrate(uint256)", "oldToken()")), false);
  // the MATIC vault from the backfill: migrate() + both conversions, no asset()/totalAssets()
  assert.equal(isErc4626Vault(sel("migrate(uint256)", "migrateLegacyMatic(uint256)", "convertToShares(uint256)", "convertToAssets(uint256)")), true);
});

test("swap / flash-loan callbacks mark a bot, not a migrator", async () => {
  const { hasBotCallbacks } = await import("./tokenSignals.js");
  const { toFunctionSelector } = await import("viem");
  const sel = (s: string) => toFunctionSelector(s);
  assert.equal(hasBotCallbacks([sel("migrate(address)"), sel("uniswapV3SwapCallback(int256,int256,bytes)")]), true);
  assert.equal(hasBotCallbacks([sel("executeOperation(address,uint256,uint256,address,bytes)")]), true);
  assert.equal(hasBotCallbacks([sel("receiveFlashLoan(address[],uint256[],uint256[],bytes)")]), true);
  assert.equal(hasBotCallbacks([sel("migrate(uint256)"), sel("oldToken()"), sel("newToken()")]), false);
});

test("pool-graduation settings mark a launchpad token", async () => {
  const { isLaunchpadToken } = await import("./tokenSignals.js");
  const sel = (s: string) => toFunctionSelector(s);
  assert.equal(isLaunchpadToken([sel("migrate()"), sel("setMigratedPool(address,bool)")]), true);
  assert.equal(isLaunchpadToken([sel("migratedPools(address)")]), true);
  assert.equal(isLaunchpadToken([sel("migrate(uint256)"), sel("oldToken()"), sel("newToken()")]), false);
});

test("bridged blue chips are base assets: BTCB and Binance-Peg ETH on BSC, WBTC and cbBTC elsewhere", async () => {
  const { isBaseAsset } = await import("../config/marketAssets.js");
  assert.equal(isBaseAsset("bsc", "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"), true); // BTCB
  assert.equal(isBaseAsset("bsc", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8"), true); // Binance-Peg ETH
  assert.equal(isBaseAsset("base", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"), true); // cbBTC
  assert.equal(isBaseAsset("arbitrum", "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"), true); // WBTC
  assert.equal(isBaseAsset("bsc", "0x9DBC36B85b4EFB9E7Aa25FbDb913Ba6C52999999"), false); // an ordinary token
});
