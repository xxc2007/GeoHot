// 本地部署文档的守卫：2026-11-15 用干净 clone 实测时，README 的「七条命令」在自动化 shell 里
// 卡在 `nohup npm run db:up`（Git Bash 的 npm 是 .cmd 壳），冒烟命令也不存在，害得复验补了六条。
// 这里钉住那三条：后台起库直接调 node 入口、冒烟走 npm 别名、README 里必须写明前端要构建。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

test("冒烟命令有 npm 别名，README 用它", () => {
  assert.equal(pkg.scripts.smoke, "node --env-file-if-exists=.env scripts/smoke.ts");
  assert.match(readme, /npm run smoke -- --base http:\/\/127\.0\.0\.1:3099/);
});

test("后台起库写明要直接调 node 入口，不能 nohup npm", () => {
  assert.match(readme, /node scripts\/dev-db\.ts --daemon --port=5455/);
  assert.match(readme, /nohup npm run db:up/);
});

test("冒烟之前要构建前端，迁移条数与实际一致", () => {
  assert.match(readme, /npm run build -w @aihot\/web && node --env-file=\.env apps\/web\/server\.ts/);
  assert.doesNotMatch(readme, /干净库 108 条迁移/);
  assert.match(readme, /干净库 114 条迁移/);
});
