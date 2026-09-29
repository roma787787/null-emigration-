import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCustomNetworks } from "./networks.js";

const BUILTINS = ["ethereum", "base", "polygon-zkevm"];

test("parses a fully specified custom network", () => {
  const { specs, errors } = parseCustomNetworks(
    {
      EXTRA_NETWORKS: "sonic",
      NETWORK_SONIC_CHAIN_ID: "146",
      NETWORK_SONIC_NAME: "Sonic",
      NETWORK_SONIC_EXPLORER: "https://sonicscan.org/",
      NETWORK_SONIC_DEXSCREENER: "sonic",
      RPC_SONIC: "wss://sonic.example/ws,https://sonic.example/rpc",
    },
    BUILTINS,
  );

  assert.deepEqual(errors, []);
  const sonic = specs.sonic!;
  assert.equal(sonic.label, "Sonic");
  assert.equal(sonic.chain.id, 146);
  assert.equal(sonic.explorerBaseUrl, "https://sonicscan.org");
  assert.deepEqual(sonic.chain.rpcUrls.default.http, ["https://sonic.example/rpc"]);
});

test("only chain id and RPC are required; name/dexscreener default to the key, explorer to none", () => {
  const { specs, errors } = parseCustomNetworks(
    { EXTRA_NETWORKS: "mantle", NETWORK_MANTLE_CHAIN_ID: "5000", RPC_MANTLE: "https://rpc.mantle.xyz" },
    BUILTINS,
  );

  assert.deepEqual(errors, []);
  assert.equal(specs.mantle!.label, "mantle");
  assert.equal(specs.mantle!.dexscreenerSlug, "mantle");
  assert.equal(specs.mantle!.explorerBaseUrl, null);
});

test("hyphenated keys map to underscored env var names", () => {
  const { specs, errors } = parseCustomNetworks(
    { EXTRA_NETWORKS: "zk-sync", NETWORK_ZK_SYNC_CHAIN_ID: "324", RPC_ZK_SYNC: "https://mainnet.era.zksync.io" },
    BUILTINS,
  );

  assert.deepEqual(errors, []);
  assert.equal(specs["zk-sync"]!.chain.id, 324);
});

test("a misconfigured network is skipped with an error, without affecting valid ones", () => {
  const { specs, errors } = parseCustomNetworks(
    {
      EXTRA_NETWORKS: "good,nochain,norpc,ethereum,Bad Key",
      NETWORK_GOOD_CHAIN_ID: "1",
      RPC_GOOD: "https://good.example",
      RPC_NOCHAIN: "https://x.example",
      NETWORK_NORPC_CHAIN_ID: "7",
    },
    BUILTINS,
  );

  assert.deepEqual(Object.keys(specs), ["good"]);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => e.includes("NETWORK_NOCHAIN_CHAIN_ID")));
  assert.ok(errors.some((e) => e.includes("RPC_NORPC")));
  assert.ok(errors.some((e) => e.includes("already defined")));
  assert.ok(errors.some((e) => e.includes("Bad Key")));
});

test("rejects an explorer URL without a scheme", () => {
  const { specs, errors } = parseCustomNetworks(
    {
      EXTRA_NETWORKS: "foo",
      NETWORK_FOO_CHAIN_ID: "9",
      RPC_FOO: "https://foo.example",
      NETWORK_FOO_EXPLORER: "fooscan.io",
    },
    BUILTINS,
  );

  assert.deepEqual(specs, {});
  assert.equal(errors.length, 1);
});

test("no EXTRA_NETWORKS means no custom networks", () => {
  assert.deepEqual(parseCustomNetworks({}, BUILTINS), { specs: {}, errors: [] });
});

test("Robinhood Chain is built in (chain 4663, Blockscout, DexScreener slug)", async () => {
  const { getNetwork } = await import("./networks.js");
  const rh = getNetwork("robinhood");
  assert.equal(rh.chain.id, 4663);
  assert.equal(rh.explorerAddressUrl("0xabc"), "https://robinhoodchain.blockscout.com/address/0xabc");
  assert.equal(rh.dexscreenerTokenUrl("0xabc"), "https://dexscreener.com/robinhood/0xabc");
});
