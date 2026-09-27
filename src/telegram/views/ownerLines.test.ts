import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOwnerLines } from "./ownerLines.js";

const owner = (i: number) => ({ address: `0x${String(i).padStart(40, "0")}`, source: "default_admin_role" });

test("lists every wallet when there are few", () => {
  assert.equal(formatOwnerLines([owner(1), owner(2)], "en", "  ").split("\n").length, 2);
});

test("caps a long list and says how many are hidden", () => {
  const text = formatOwnerLines(Array.from({ length: 60 }, (_, i) => owner(i)), "ru", "    ");
  const lines = text.split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines.at(-1), "    … и ещё 52");
});
