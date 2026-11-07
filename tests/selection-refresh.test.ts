import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../packages/backend/src/publication/selection-refresh.ts", import.meta.url),
  "utf8",
);
const schedules = readFileSync(new URL("../apps/worker/src/schedules.ts", import.meta.url), "utf8");

test("补选只动从未被裁定过的全文就绪条目", () => {
  assert.match(source, /p\.selected_ready_at is null/);
  assert.match(source, /p\.body_mode = 'full'/);
  assert.match(source, /r\.ready = true/);
});

test("撤选只针对非全文的自动选中条目", () => {
  assert.match(source, /p\.body_mode <> 'full'/);
  assert.match(source, /set selected = false/);
});

test("精选重算挂在定时任务里，且不会覆盖人工调整", () => {
  assert.match(schedules, /name: "content\.select"/);
  assert.match(source, /不会覆盖后台人工调整过的精选/);
});
