import { test } from "node:test";
import assert from "node:assert/strict";
import { ListingBatcher, type ListingBatch, type RwaListing } from "./listings.js";
import { formatListingAlert } from "../telegram/listingFormatter.js";
import { markdownV2Problem } from "../../e2e/markdownV2.js";

const listing = (i: number, issuer = "Robinhood Stock Tokens"): RwaListing => ({
  network: "robinhood",
  issuer,
  address: `0x${i.toString(16).padStart(40, "0")}`,
  symbol: `TKN${i}`,
  name: `Token ${i} Inc.`,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function batcher(now: () => number = Date.now) {
  const sent: ListingBatch[] = [];
  const b = new ListingBatcher(
    async (batch) => {
      sent.push(batch);
    },
    { windowMs: 20, busyWindowMs: 60, singleMax: 3, hourlyCap: 5 },
    now,
  );
  return { b, sent };
}

test("a lone new token goes out as its own card after the window", async () => {
  const { b, sent } = batcher();
  b.add(listing(1));
  assert.equal(sent.length, 0);
  await wait(40);
  assert.deepEqual(sent.map((s) => s.listings.length), [1]);
});

test("a launch of many tokens at once becomes ONE digest", async () => {
  const { b, sent } = batcher();
  for (let i = 0; i < 200; i++) b.add(listing(i));
  await wait(40);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.listings.length, 200);
});

test("the same token twice is listed once", async () => {
  const { b, sent } = batcher();
  b.add(listing(7));
  b.add(listing(7));
  await wait(40);
  assert.equal(sent.flatMap((s) => s.listings).length, 1);
});

test("issuers are grouped separately", async () => {
  const { b, sent } = batcher();
  b.add(listing(1, "Robinhood Stock Tokens"));
  b.add(listing(2, "Dinari dShares"));
  await wait(40);
  assert.deepEqual(sent.map((s) => s.issuer).sort(), ["Dinari dShares", "Robinhood Stock Tokens"]);
});

test("a slow trickle: separate cards up to the hourly cap, then digests on the longer window", async () => {
  const { b, sent } = batcher();
  for (let i = 0; i < 5; i++) {
    b.add(listing(i));
    await wait(30);
  }
  assert.equal(sent.length, 5, "5 separate cards (the cap)");
  b.add(listing(100));
  await wait(30);
  assert.equal(sent.length, 6);
  assert.equal(sent[5]!.listings.length, 1, "over the cap: goes out as a digest of what waited");
  // Busy now: the next ones wait for the longer window and arrive together.
  b.add(listing(101));
  await wait(30);
  b.add(listing(102));
  assert.equal(sent.length, 6, "still waiting on the busy window");
  await wait(60);
  assert.equal(sent.length, 7);
  assert.equal(sent[6]!.listings.length, 2);
});

test("flushAll sends what is still waiting (shutdown)", async () => {
  const { b, sent } = batcher();
  b.add(listing(1));
  await b.flushAll();
  assert.equal(sent.length, 1);
});

test("listing card and digest are valid MarkdownV2 in 3 languages; a digest names 20 and counts the rest", () => {
  const tricky: RwaListing = { ...listing(1), symbol: "BRK.B", name: "Berkshire Hathaway (Class B) - 100%" };
  for (const lang of ["en", "uk", "ru"] as const) {
    const single = formatListingAlert({ network: "robinhood", issuer: "Robinhood Stock Tokens", listings: [tricky] }, lang);
    assert.equal(markdownV2Problem(single), null, single);
    assert.match(single, /BRK\\\.B/);
    assert.match(single, /robinhoodchain\.blockscout\.com\/address\/0x0+1/);
    const digest = formatListingAlert(
      { network: "robinhood", issuer: "Robinhood Stock Tokens", listings: Array.from({ length: 45 }, (_, i) => listing(i)) },
      lang,
    );
    assert.equal(markdownV2Problem(digest), null, digest);
    assert.ok(digest.length < 4096, `${digest.length} chars`);
    assert.equal((digest.match(/^• /gm) ?? []).length, 20);
    assert.match(digest, /25/);
  }
});
