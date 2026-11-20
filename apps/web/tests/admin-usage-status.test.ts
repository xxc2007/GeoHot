import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asOfCoversDay,
  beijingDayStart,
  classifyUsageView,
  rangeIncludesToday,
} from "../app/lib/usage-status.ts";

// Beijing today fixed at 2026-11-17 (a Tuesday). All instants are ISO strings.
const TODAY = "2026-11-17";
const AS_OF_TODAY = "2026-11-17T03:30:00.000Z"; // 11:30 Beijing on 2026-11-17
const AS_OF_YESTERDAY = "2026-11-16T10:00:00.000Z"; // 18:00 Beijing on 2026-11-16

test("beijingDayStart is +08:00 midnight", () => {
  // 2026-11-17 00:00 Beijing == 2026-11-16T16:00:00Z
  assert.equal(beijingDayStart("2026-11-17"), Date.parse("2026-11-16T16:00:00Z"));
});

test("asOfCoversDay compares against Beijing midnight, not UTC day", () => {
  // 2026-11-17T03:30Z is 11:30 Beijing 11-17 -> covers today
  assert.equal(asOfCoversDay(AS_OF_TODAY, TODAY), true);
  // 18:00 Beijing 11-16 is before Beijing midnight 11-17 -> does NOT cover today
  assert.equal(asOfCoversDay(AS_OF_YESTERDAY, TODAY), false);
  // null / garbage never covers
  assert.equal(asOfCoversDay(null, TODAY), false);
  assert.equal(asOfCoversDay("not-an-instant", TODAY), false);
});

test("rangeIncludesToday: today/7/30/90/all include today; a past selected date does not", () => {
  for (const range of ["today", "7", "30", "90", "all"]) {
    assert.equal(rangeIncludesToday(range, null, TODAY), true, range);
  }
  assert.equal(rangeIncludesToday("date", "2026-11-10", TODAY), false);
  assert.equal(rangeIncludesToday("date", TODAY, TODAY), true);
});

test("load failure with no fallback -> error state, real message, numbers unverified", () => {
  const v = classifyUsageView({
    statusState: "error", asOf: null, totalCalls: 0, range: "today",
    selectedDate: null, today: TODAY, hasFallback: false,
    loadError: "用量数据加载失败（后台请求超时或不可用）。",
  });
  assert.equal(v.state, "error");
  assert.equal(v.stale, false);
  assert.equal(v.numbersUnverified, true);
  assert.match(v.notice, /超时或不可用/);
});

test("load failure with same-scope fallback -> degrades to stale, no error screen", () => {
  const v = classifyUsageView({
    statusState: "error", asOf: AS_OF_TODAY, totalCalls: 120, range: "today",
    selectedDate: null, today: TODAY, hasFallback: true, loadError: "boom",
  });
  assert.equal(v.state, "stale");
  assert.equal(v.stale, true);
  assert.match(v.notice, /保留上次成功统计/);
});

test("backend still generating (no snapshot) -> generating state, never zeros", () => {
  const v = classifyUsageView({
    statusState: "unavailable", asOf: null, totalCalls: 0, range: "today",
    selectedDate: null, today: TODAY, hasFallback: false, loadError: null,
  });
  assert.equal(v.state, "generating");
  assert.equal(v.numbersUnverified, true);
  assert.match(v.notice, /尚未取得数据，不代表用量为零/);
});

test("ready with zero calls and today covered -> ready-empty (real empty, not loading)", () => {
  const v = classifyUsageView({
    statusState: "ready", asOf: AS_OF_TODAY, totalCalls: 0, range: "today",
    selectedDate: null, today: TODAY, hasFallback: false, loadError: null,
  });
  assert.equal(v.state, "ready-empty");
  assert.equal(v.stale, false);
  assert.equal(v.numbersUnverified, false);
});

test("ready with calls -> ready-data", () => {
  const v = classifyUsageView({
    statusState: "ready", asOf: AS_OF_TODAY, totalCalls: 42, range: "today",
    selectedDate: null, today: TODAY, hasFallback: false, loadError: null,
  });
  assert.equal(v.state, "ready-data");
  assert.equal(v.stale, false);
});

test("cross-Beijing-day: snapshot from yesterday while viewing today -> stale, today not asserted zero", () => {
  const v = classifyUsageView({
    statusState: "ready", asOf: AS_OF_YESTERDAY, totalCalls: 0, range: "today",
    selectedDate: null, today: TODAY, hasFallback: false, loadError: null,
  });
  assert.equal(v.state, "stale");
  assert.equal(v.numbersUnverified, true);
  assert.match(v.notice, /尚未覆盖今日/);
  assert.match(v.notice, /不代表今日为 0/);
});

test("backend explicitly stale -> stale state with refresh notice", () => {
  const v = classifyUsageView({
    statusState: "stale", asOf: AS_OF_TODAY, totalCalls: 300, range: "7",
    selectedDate: null, today: TODAY, hasFallback: false, loadError: null,
  });
  assert.equal(v.state, "stale");
  assert.match(v.notice, /保留上次成功统计/);
});

test("selected past date covered by snapshot does NOT trigger today-not-covered warning", () => {
  const v = classifyUsageView({
    statusState: "ready", asOf: AS_OF_YESTERDAY, totalCalls: 5, range: "date",
    selectedDate: "2026-11-16", today: TODAY, hasFallback: false, loadError: null,
  });
  // asOf 18:00 Beijing 11-16 covers 2026-11-16 fully; not viewing today -> ready-data
  assert.equal(v.state, "ready-data");
  assert.equal(v.stale, false);
});
