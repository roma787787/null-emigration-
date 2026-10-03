import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBackfillRange } from "./backfill.js";

const now = new Date(Date.UTC(2026, 9, 3, 12, 0)); // 3 Oct 2026, 12:00 UTC
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;

test("days, hours and block counts back from now", () => {
  assert.deepEqual(parseBackfillRange("7d", now), { seconds: 7 * 86_400 });
  assert.deepEqual(parseBackfillRange("12h", now), { seconds: 12 * 3_600 });
  assert.deepEqual(parseBackfillRange("5000", now), { blocks: 5000 });
  assert.equal(parseBackfillRange("32d", now), null);
});

test("calendar dates: both days included, UTC, the year guessed when left out", () => {
  assert.deepEqual(parseBackfillRange("01.09-10.09", now), { fromSec: day(2026, 9, 1), toSec: day(2026, 9, 11) });
  assert.deepEqual(parseBackfillRange("05.09", now), { fromSec: day(2026, 9, 5), toSec: day(2026, 9, 6) });
  assert.deepEqual(parseBackfillRange("20.12.2025-05.01.2026", now), { fromSec: day(2025, 12, 20), toSec: day(2026, 1, 6) });
  // a day later in the year than today means last year
  assert.deepEqual(parseBackfillRange("20.12-25.12", now), { fromSec: day(2025, 12, 20), toSec: day(2025, 12, 26) });
  // a range reaching today stops at now
  assert.deepEqual(parseBackfillRange("01.10-03.10", now), { fromSec: day(2026, 10, 1), toSec: now.getTime() / 1000 });
});

test("bad dates are refused", () => {
  assert.equal(parseBackfillRange("10.09-01.09", now), null); // backwards
  assert.equal(parseBackfillRange("31.02", now), null); // no such day
  assert.equal(parseBackfillRange("01.01.2026-15.03.2026", now), null); // over 31 days
  assert.equal(parseBackfillRange("05.10.2026", now), null); // in the future
  assert.equal(parseBackfillRange("1.2.3.4", now), null);
});
