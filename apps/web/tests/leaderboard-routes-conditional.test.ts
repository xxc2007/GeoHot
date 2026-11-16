// FEATURES.leaderboard=false 时，leaderboard 路由不应注册，对应 chunk 不应出现在构建产物里。
// 旧链接的公开重定向（/leaderboard/methodology 等）仍由 http-policy.ts 的 REDIRECTS 处理，不需要页面路由。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const assetsDir = fileURLToPath(new URL("../build/client/assets", import.meta.url));

test("构建产物里没有 leaderboard 路由 chunk", () => {
  if (!existsSync(assetsDir)) {
    throw new Error("build/client/assets 不存在；先跑 npm run build -w @aihot/web");
  }
  const files = readdirSync(assetsDir).filter((f) => /leaderboard/i.test(f));
  assert.deepEqual(files, [], `leaderboard chunk 不应出现: ${files.join(", ")}`);
});

test("routes.ts 用 FEATURES.leaderboard 条件展开", () => {
  const src = readFileSync(fileURLToPath(new URL("../app/routes.ts", import.meta.url)), "utf8");
  assert.match(src, /FEATURES\.leaderboard/, "要读 FEATURES.leaderboard");
  assert.match(src, /\.\.\.\(FEATURES\.leaderboard/, "leaderboard 路由要条件 spread");
});
