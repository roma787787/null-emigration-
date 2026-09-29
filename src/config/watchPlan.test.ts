import { test } from "node:test";
import assert from "node:assert/strict";
import { planWatch } from "./watchPlan.js";

const ENABLED = ["ethereum", "arbitrum", "optimism", "polygon", "avalanche", "linea", "scroll", "blast", "polygon-zkevm", "hyperevm"];

test("production config: empty AUTO_DISCOVERY_NETWORKS covers enabled networks only — custodian networks still get the watch", () => {
  // ENABLED_NETWORKS=…, AUTO_DISCOVERY_NETWORKS unset, CUSTODIAN_NETWORKS=base,robinhood
  const plan = planWatch({ enabled: ENABLED, autoOn: true, autoList: [], custodianList: ["base", "robinhood"], custodianWatch: true });
  assert.deepEqual(plan.auto, ENABLED);
  assert.deepEqual(plan.custodians, ["base", "robinhood"]);
});

test("an enabled network outside AUTO_DISCOVERY_NETWORKS gets the custodian watch", () => {
  const plan = planWatch({ enabled: ["ethereum", "arbitrum"], autoOn: true, autoList: ["ethereum"], custodianList: ["robinhood"], custodianWatch: true });
  assert.deepEqual(plan.auto, ["ethereum"]);
  assert.deepEqual(plan.custodians, ["arbitrum", "robinhood"]);
});

test("a CUSTODIAN_NETWORKS entry already under auto-discovery isn't watched twice", () => {
  const plan = planWatch({ enabled: ["ethereum", "base"], autoOn: true, autoList: [], custodianList: ["base", "robinhood"], custodianWatch: true });
  assert.deepEqual(plan.custodians, ["robinhood"]);
});

test("auto-discovery off or paused: every network is custodian-watched; CUSTODIAN_WATCH=false: none", () => {
  const off = planWatch({ enabled: ["ethereum"], autoOn: false, autoList: [], custodianList: ["robinhood"], custodianWatch: true });
  assert.deepEqual(off, { auto: [], custodians: ["ethereum", "robinhood"] });
  const none = planWatch({ enabled: ["ethereum"], autoOn: true, autoList: [], custodianList: ["robinhood"], custodianWatch: false });
  assert.deepEqual(none, { auto: ["ethereum"], custodians: [] });
});
