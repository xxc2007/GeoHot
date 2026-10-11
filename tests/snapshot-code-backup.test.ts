// 上线前的代码快照不许把密钥打进去。
//
// 这条规则以前只写在 `deploy/geohot/DEPLOYMENT.md` 的一行命令里，而那行命令是错的：
// `tar --exclude=./app/.env … -C /opt/geohot app` 存进包的成员名是 `app/.env`，带 `./` 前缀的模式
// 一条都不命中，所以"排除 .env"的说明和实际行为相反（2026-10-11 用 GNU tar 1.35 复现，
// 并由运维核查在生产备份里翻出了 `./.env`）。命令搬进 `snapshot-code.sh`，判据落在包里。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve(import.meta.dirname, "../deploy/geohot/snapshot-code.sh");
const tools = [spawnSync("bash", ["-c", "true"], { encoding: "utf8" }), spawnSync("tar", ["--version"], { encoding: "utf8" })];
const missing = tools.some((r) => r.error || r.status !== 0);

test("上线前的代码快照：密钥不进包，可恢复的东西都要在", (t) => {
  if (missing) return t.skip("本机没有 bash 或 tar，这条判据跑不了");
  const root = mkdtempSync(path.join(tmpdir(), "geohot-snapshot-"));
  const app = path.join(root, "app");
  try {
    mkdirSync(path.join(app, "sub"), { recursive: true });
    mkdirSync(path.join(app, ".data"), { recursive: true });
    writeFileSync(path.join(app, ".env"), "LLM_API_KEY=secret-not-for-the-backup\n");
    writeFileSync(path.join(app, ".env.pipeline"), "MODEL_CALLS_ENABLED=true\n");
    writeFileSync(path.join(app, ".env.bak-20261010"), "OLD=1\n");
    writeFileSync(path.join(app, ".env.example"), "LLM_API_KEY=\n");
    writeFileSync(path.join(app, "sub", "a.txt"), "code\n");
    writeFileSync(path.join(app, ".data", "cursor.json"), "{}\n");
    const out = path.join(root, "backups");
    // Git Bash 里的 dirname/basename 不认反斜杠，所以给它正斜杠写法；Linux 上这一步是恒等变换。
    const posix = (p: string) => p.replace(/\\/g, "/");
    const run = spawnSync("bash", [SCRIPT, "selftest.tar.gz"], {
      encoding: "utf8", env: { ...process.env, GEOHOT_APP_ROOT: posix(app), GEOHOT_BACKUP_DIR: posix(out) },
    });
    assert.equal(run.status, 0, `脚本失败：${run.stderr}`);
    const pack = path.join(out, "selftest.tar.gz");
    // 列表也走 bash，并且进目录用相对名：本机那个 `tar` 是 Git Bash 的 GNU tar，`C:\…` 或 `C:/…` 会被它
    // 当成远程主机（`Cannot connect to C: resolve failed`），直接用绝对路径递给它是假红。
    const listing = spawnSync("bash", ["-c", `cd "$1" && tar tzf "$2"`, "bash", posix(out), "selftest.tar.gz"], { encoding: "utf8" }).stdout.split("\n");
    assert.ok(listing.some((l) => l.endsWith("sub/a.txt")), "代码要在包里");
    assert.ok(listing.some((l) => l.endsWith(".env.example")), "仓库自带的模板不是密钥，要留着");
    for (const leak of [".env", ".env.pipeline", ".env.bak-20261010", ".data"]) {
      assert.ok(!listing.some((l) => l.split("/").includes(leak)), `包里不该有 ${leak}`);
    }
    // 0600：默认 umask 下的 0644 等于让本机任何进程都能读走密钥——那条已经修过一次，别再退回去。
    // Windows 上 umask 与这些权限位都不成立，这一步只在真正会跑这条命令的系统上判。
    assert.equal(readdirSync(out).length, 1);
    if (process.platform !== "win32") assert.equal(statSync(pack).mode & 0o077, 0, "快照包不能对同组或其他人可读");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("快照脚本不会把包写到别人目录里去", (t) => {
  if (missing) return t.skip("本机没有 bash 或 tar，这条判据跑不了");
  const run = spawnSync("bash", [SCRIPT, "../evil.tar.gz"], {
    encoding: "utf8", env: { ...process.env, GEOHOT_APP_ROOT: process.cwd(), GEOHOT_BACKUP_DIR: process.cwd() },
  });
  assert.equal(run.status, 2, "包名带路径必须被拒绝");
  assert.ok(!readdirSync(process.cwd()).includes("evil.tar.gz"), "拒绝的同时不该留下文件");
});
