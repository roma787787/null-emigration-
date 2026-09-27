import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFunctionSignature } from "./functionClassifier.js";

test("project-specific migration names are strong", () => {
  for (const sig of [
    "migrate(uint256)",
    "migrateFromLEND(uint256)",
    "unmigrate(uint256)",
    "mkrToSky(address,uint256)",
    "daiToUsds(address,uint256)",
    "convertTokens(uint256)",
    "swap(uint256)",
    "exchange(uint256)",
  ]) {
    assert.equal(classifyFunctionSignature(sig), "strong", sig);
  }
});

test("claim/redeem/deposit are weak", () => {
  for (const sig of ["claim()", "redeem(uint256)", "deposit(uint256)", "claimTokens(uint256)"]) {
    assert.equal(classifyFunctionSignature(sig), "weak", sig);
  }
});

test("generic verbs with a 'To' suffix and proxy admin functions are not migration signals", () => {
  for (const sig of [
    "transferTo(address,uint256)",
    "mintTo(address,uint256)",
    "setToken(address)",
    "upgradeTo(address)",
    "upgradeToAndCall(address,bytes)",
    "transfer(address,uint256)",
    "balanceOf(address)",
  ]) {
    assert.equal(classifyFunctionSignature(sig), null, sig);
  }
});
