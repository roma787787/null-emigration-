// Pulls the compiled bytecode of real production contracts from their
// published npm packages into e2e/real-artifacts.json, so the e2e tests can
// deploy the genuine article (not a look-alike fixture):
//   - Aave's LendToAaveMigrator + InitializableAdminUpgradeabilityProxy
//     (@aave/aave-token) — the LEND→AAVE migration
//   - Uniswap V2 Factory / Pair (@uniswap/v2-core) — the pools that
//     auto-discovery must NOT mistake for migrations
// Usage: node e2e/fetch-real-artifacts.cjs
const { execSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const SOURCES = {
  "@aave/aave-token@1.0.4": {
    LendToAaveMigrator: "artifacts/contracts/token/LendToAaveMigrator.sol/LendToAaveMigrator.json",
    InitializableAdminUpgradeabilityProxy:
      "artifacts/contracts/open-zeppelin/InitializableAdminUpgradeabilityProxy.sol/InitializableAdminUpgradeabilityProxy.json",
  },
  "@uniswap/v2-core@1.0.1": {
    UniswapV2Factory: "build/UniswapV2Factory.json",
    UniswapV2Pair: "build/UniswapV2Pair.json",
  },
};

const out = {};
for (const [pkg, files] of Object.entries(SOURCES)) {
  const dir = mkdtempSync(path.join(tmpdir(), "real-artifacts-"));
  const tarball = execSync(`npm pack ${pkg} --silent`, { cwd: dir }).toString().trim().split("\n").pop();
  execSync(`tar xzf ${tarball}`, { cwd: dir });
  for (const [name, file] of Object.entries(files)) {
    const json = JSON.parse(readFileSync(path.join(dir, "package", file), "utf8"));
    const bytecode = json.bytecode?.startsWith?.("0x") ? json.bytecode : `0x${json.bytecode ?? json.evm.bytecode.object}`;
    out[name] = { package: pkg, abi: json.abi, bytecode };
  }
}
writeFileSync(path.join(__dirname, "real-artifacts.json"), JSON.stringify(out));
console.log("wrote", Object.keys(out).join(", "));
