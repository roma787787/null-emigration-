// Regenerates e2e/artifacts.json from Fixtures.sol.
// Usage: npm i --no-save solc@0.8.24 && node e2e/compile.cjs
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const input = {
  language: "Solidity",
  sources: { "Fixtures.sol": { content: fs.readFileSync(path.join(__dirname, "Fixtures.sol"), "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
const artifacts = {};
for (const [name, c] of Object.entries(out.contracts["Fixtures.sol"])) {
  artifacts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}
fs.writeFileSync(path.join(__dirname, "artifacts.json"), JSON.stringify(artifacts, null, 2));
console.log("compiled:", Object.keys(artifacts).join(", "));
