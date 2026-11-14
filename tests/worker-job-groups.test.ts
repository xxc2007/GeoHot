import test from "node:test";
import assert from "node:assert/strict";
import { jobGroups } from "../packages/backend/src/jobs/worker-role.ts";

// 2026-11-14 事故：coordinator(role=all) 走进 `if (plan.extraction)` 分支后，
// sources.fetch / events.group / publication / 定时任务全都没注册，队列一路涨到没人领。
test("coordinator registers collection, events, publication and schedules", () => {
  const groups = jobGroups("all");
  assert.deepEqual(groups, {
    content: true,
    extraction: true,
    source: true,
    events: true,
    notify: true,
    publication: true,
    schedules: true,
    media: false,
    sourceIncludesExtraction: false,
  });
});

test("content executor only claims content and extraction", () => {
  const groups = jobGroups("content-executor");
  assert.equal(groups.content, true);
  assert.equal(groups.extraction, true);
  assert.equal(groups.source, false);
  assert.equal(groups.schedules, false);
});

test("fetcher claims collection only", () => {
  const groups = jobGroups("fetcher");
  assert.equal(groups.content, false);
  assert.equal(groups.extraction, false);
  assert.equal(groups.source, true);
  assert.equal(groups.events, false);
});

test("media claims media only", () => {
  const groups = jobGroups("media");
  assert.equal(groups.media, true);
  assert.equal(groups.extraction, false);
  assert.equal(groups.source, false);
});

test("extraction executor claims extraction only", () => {
  const groups = jobGroups("extraction-executor");
  assert.equal(groups.extraction, true);
  assert.equal(groups.content, false);
  assert.equal(groups.source, false);
  assert.equal(groups.events, false);
});
