import assert from "node:assert/strict";
import test from "node:test";
import { scheduleBatchLimit } from "@aihot/backend/sources/collect";

const original = process.env.FETCH_SCHEDULE_BATCH;

test.afterEach(() => {
  if (original === undefined) delete process.env.FETCH_SCHEDULE_BATCH;
  else process.env.FETCH_SCHEDULE_BATCH = original;
});

test("balanced=true defaults to 12 when env unset", () => {
  delete process.env.FETCH_SCHEDULE_BATCH;
  assert.equal(scheduleBatchLimit(true), 12);
});

test("balanced=false defaults to 40 when env unset", () => {
  delete process.env.FETCH_SCHEDULE_BATCH;
  assert.equal(scheduleBatchLimit(false), 40);
});

test("balanced=true honors FETCH_SCHEDULE_BATCH=1", () => {
  process.env.FETCH_SCHEDULE_BATCH = "1";
  assert.equal(scheduleBatchLimit(true), 1);
});

test("balanced=false honors FETCH_SCHEDULE_BATCH=25", () => {
  process.env.FETCH_SCHEDULE_BATCH = "25";
  assert.equal(scheduleBatchLimit(false), 25);
});

test("invalid env falls back to balanced default", () => {
  process.env.FETCH_SCHEDULE_BATCH = "abc";
  assert.equal(scheduleBatchLimit(true), 12);
  assert.equal(scheduleBatchLimit(false), 40);
});

test("zero or negative env falls back to balanced default", () => {
  process.env.FETCH_SCHEDULE_BATCH = "0";
  assert.equal(scheduleBatchLimit(true), 12);
  process.env.FETCH_SCHEDULE_BATCH = "-5";
  assert.equal(scheduleBatchLimit(false), 40);
});
