import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeFunctionData, toFunctionSelector } from "viem";
import { carriesInitCode } from "./traceCreateDetector.js";

const artifacts = JSON.parse(readFileSync(new URL("../../e2e/artifacts.json", import.meta.url), "utf8")) as Record<
  string,
  { abi: unknown[]; bytecode: `0x${string}` }
>;

test("a call shipping Solidity creation code is traced", () => {
  const data = encodeFunctionData({
    abi: artifacts.BytecodeDeployer!.abi as never,
    functionName: "deploy",
    args: [artifacts.MigratorWithGetters!.bytecode, `0x${"11".repeat(32)}`],
  } as never);
  assert.equal(carriesInitCode(data), true);
});

test("an EIP-1167 clone's creation code in calldata is traced", () => {
  const clone = "3d602d80600a3d3981f3363d3d373d3d3d363d73" + "ab".repeat(20) + "5af43d82803e903d91602b57fd5bf3";
  assert.equal(carriesInitCode(toFunctionSelector("create(bytes)") + "0".repeat(126) + clone), true);
});

test("ordinary calls are not: transfers, swaps with paths, approvals", () => {
  const transfer = toFunctionSelector("transfer(address,uint256)") + "00".repeat(64);
  const swap = toFunctionSelector("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)") + "12".repeat(300);
  assert.equal(carriesInitCode(transfer), false);
  assert.equal(carriesInitCode(swap), false);
  assert.equal(carriesInitCode("0x"), false);
});
