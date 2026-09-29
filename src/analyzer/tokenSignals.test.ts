import { test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { isErc4626Vault, isMigrationAction } from "./tokenSignals.js";

test("migration actions count; settings, flags, views and ERC-4626 conversions don't", () => {
  for (const name of ["migrate", "migrateFromLEND", "migrateTokens", "convert", "convertTokens", "convertOldToNew"]) {
    assert.equal(isMigrationAction(name), true, name);
  }
  for (const name of [
    "setMigratedPool", "setMigratedPools", "migratedPools", "migrationEnded", "migrationStarted",
    "isConverted", "convertedAmount", "convertToShares", "convertToAssets", "_totalLendMigrated",
  ]) {
    assert.equal(isMigrationAction(name), false, name);
  }
});

test("ERC-4626 vaults are recognised by asset/totalAssets + convertTo*", () => {
  const sel = (...sigs: string[]) => sigs.map((s) => toFunctionSelector(s));
  assert.equal(isErc4626Vault(sel("asset()", "totalAssets()", "convertToShares(uint256)", "convertToAssets(uint256)")), true);
  assert.equal(isErc4626Vault(sel("asset()", "convertToShares(uint256)")), false);
  assert.equal(isErc4626Vault(sel("migrate(uint256)", "oldToken()")), false);
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
