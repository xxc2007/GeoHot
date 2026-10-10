// Published dates on list pages: a date without a zone is read in the source's offset, whatever zone
// the server runs in (Docker runs in UTC; run this file with TZ=UTC and TZ=Asia/Shanghai to see both).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLooseDate } from "@aihot/backend/sources/web-list";

const iso = (v: string, offset?: string, order?: string) =>
  parseLooseDate(v, { publishedAtUtcOffset: offset, publishedAtDateOrder: order })?.toISOString() ?? null;

test("a date and time without a zone is in the source's offset, not the server's", () => {
  assert.equal(iso("2026-09-26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026/09/26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026年9月26日 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00", "-07:00"), "2026-09-26T17:00:00.000Z");
});

test("a bare date is midnight in the source's offset; an ISO date alone stays UTC midnight", () => {
  assert.equal(iso("2026/09/26"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026年9月26日"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026-09-26"), "2026-09-26T00:00:00.000Z");
  assert.equal(iso("September 26th, 2026", "+00:00"), "2026-09-26T00:00:00.000Z");
});

test("a date that carries its zone keeps it", () => {
  assert.equal(iso("2026-09-26T10:00:00Z"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00.000+09:00"), "2026-09-26T01:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 GMT"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 +0200", "-07:00"), "2026-09-26T08:00:00.000Z");
});

test("no date at all is null", () => {
  assert.equal(iso(""), null);
  assert.equal(iso("yesterday"), null);
});

test("a date whose year comes last is not read until the source says which order it uses", () => {
  // Date.parse alone read the American order for every feed: October 7 came back as July 10, and a feed
  // that printed the 31st lost its date entirely, because 31 cannot be a month. The reading now has to be
  // declared, so the same bytes give a different date depending on which country wrote the feed.
  assert.equal(iso("07.10.2026"), null, "no order declared: no date, not a guess");
  assert.equal(iso("07/10/2026"), null);
  assert.equal(iso("07-10-2026"), null);
  assert.equal(iso("07.10.2026", "+02:00", "dmy"), "2026-10-06T22:00:00.000Z", "midnight in Oslo's own zone");
  assert.equal(iso("mer 07/10/2026 - 10:13", "+02:00", "dmy"), "2026-10-07T08:13:00.000Z");
  assert.equal(iso("07/10/2026", "-07:00", "mdy"), "2026-07-10T07:00:00.000Z");
  // A value that also carries its zone used to leave by the zone shortcut, where Date.parse reads the
  // American month/day order — the declared order was ignored and October came back as July.
  assert.equal(iso("07/10/2026 12:00:00+02:00", "+08:00", "dmy"), "2026-10-07T10:00:00.000Z", "the zone the value wrote wins over the source's offset");
  assert.equal(iso("03/04/2026-07/10/2026"), null, "two years in one value is a range, not a published moment");
});

test("a declared order the value contradicts is no date, not a swap into the other one", () => {
  assert.equal(iso("12/31/2025", "+02:00", "dmy"), null, "31 is not a month");
  assert.equal(iso("31.02.2026", "+01:00", "dmy"), null, "February 2026 has 28 days");
  assert.equal(iso("07.10.2026", "+02:00", "date-first"), null, "an order outside the enum is no order");
});

test("a zone written as an abbreviation belongs to the value, not to the source's offset", () => {
  // V8 resolves the US abbreviations (EST, EDT, CST, MST, PDT …) from its own table, so for those the
  // instant is already fixed by the value; re-reading it in the host's zone and placing those wall-clock
  // numbers in the source's offset would apply a second zone on top of the first.
  assert.equal(iso("Fri, 09 Oct 2026 12:00:00 EST", "-07:00"), "2026-10-09T17:00:00.000Z");
  assert.equal(iso("Fri, 09 Oct 2026 12:00:00 EST"), "2026-10-09T17:00:00.000Z", "the offset a source declares for its zone-less dates changes nothing here");
  assert.equal(iso("Fri, 09 Oct 2026 12:00:00 JST", "+02:00"), null, "an abbreviation the engine does not know is no date, as it was before");
});
