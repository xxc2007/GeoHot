// 模型池裁剪：把 magpie 已经不认的成员从 *_MODEL(S) 里摘掉，且不能把池子摘空。
//
// 背景（2026-11-16）：池子里躺着 11 个别名（79 个成员位）打过去就是 404，一小时 60 次
// 失败里一半是它们。判据来自 1-token 探针实测，不是拿 /v1/models 对表——magpie 能吃下
// 别名和裸 id，对表会造出假死，把能用的成员删掉。
//
// 环境注意：本机是 Git Bash，仓库路径带中文，直接把 URL 的 pathname 交给 bash 会因为
// 百分号编码找不到文件。这里把脚本先复制到纯 ASCII 的临时目录里跑，并把 Windows 路径
// 转成 MSYS 的 /c/... 形式。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../deploy/geohot/bin/prune-model-pool.sh", import.meta.url));

const posix = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, "/");

function run(envText: string, deadText: string) {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  const script = join(dir, "prune.sh");
  const dead = join(dir, "dead.txt");
  const env = join(dir, ".env");
  copyFileSync(source, script);
  writeFileSync(dead, deadText);
  writeFileSync(env, envText);
  const out = execFileSync("bash", [posix(script), posix(dead), posix(env)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C.UTF-8" } });
  return { out, env: readFileSync(env, "utf8"), dir };
}

test("死别名出局，活着的成员与其他键原样保留", () => {
  const { env, out } = run(
    ["# 注释", "SCORE_MODEL=loomy-deepseek-v41-flash,auto-hy3,qwenwork-pro", "LLM_BASE_URL=http://127.0.0.1:3426/v1", "OTHER=auto-hy3"].join("\n") + "\n",
    "# 注释\nauto-hy3\nqwenwork-pro\n",
  );
  assert.match(env, /^SCORE_MODEL=loomy-deepseek-v41-flash$/m);
  assert.match(env, /^LLM_BASE_URL=http:\/\/127\.0\.0\.1:3426\/v1$/m, "非池子行不动");
  assert.match(env, /^OTHER=auto-hy3$/m, "只在池子行里裁剪");
  assert.match(out, /摘掉 2 个成员位/);
});

test("整行都失效时保留原样，不制造空池", () => {
  const { env } = run("DOTS_MODEL=dots3-note-prev\n", "dots3-note-prev\n");
  assert.match(env, /^DOTS_MODEL=dots3-note-prev$/m);
});

test("清单里带注释与空行不影响判据，备份文件会留下", () => {
  const { dir, out } = run("SCORE_MODEL=a-dead,b-live\n", "# 说明\n\na-dead\n");
  assert.match(out, /备份 .*\.env\.bak-pool-/);
  assert.match(readFileSync(join(dir, ".env")).toString(), /^SCORE_MODEL=b-live$/m);
});
