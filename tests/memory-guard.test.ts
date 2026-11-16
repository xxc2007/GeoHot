import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.resolve("deploy/geohot/bin/memory-guard.sh");

/**
 * 2026-11-16 现场：891 MB 的主库在 `memory full avg10=96`、swap 用掉 833 MB 时，
 * `io some avg10` 也是 99，`/api/health` 要 274 秒、后台登录 504。
 * `swappiness=1` + 重启 api/web 把被换出的页收回来之后，io 98.57 → 7.02。
 * 下面三条用例钉住这个自动化的边界：过线才动手、冷却期内不重复动手、没压力时一根手指都不碰。
 */
const posix = (value: string) => value.replace(/\\/g, "/");

const PRESSURE = (full: string) =>
  `some avg10=1.00 avg60=1.00 avg300=1.00 total=1\nfull avg10=${full} avg60=1.00 avg300=1.00 total=7\n`;

const MEMINFO = (totalKb: number, freeKb: number) =>
  `MemTotal:         891000 kB\nMemFree:           20000 kB\nSwapTotal:      ${totalKb} kB\nSwapFree:       ${freeKb} kB\n`;

async function sandbox(full: string, swapTotal: number, swapFree: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "memguard-"));
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const log = path.join(dir, "systemctl.log");
  const stub = path.join(dir, "bin", "systemctl");
  await writeFile(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(posix(log))}\n`);
  await chmod(stub, 0o755);
  const pressure = path.join(dir, "pressure");
  await writeFile(pressure, PRESSURE(full));
  const meminfo = path.join(dir, "meminfo");
  await writeFile(meminfo, MEMINFO(swapTotal, swapFree));
  const env = {
    ...process.env,
    GEOHOT_MEM_GUARD_PRESSURE_FILE: posix(pressure),
    GEOHOT_MEM_GUARD_MEMINFO: posix(meminfo),
    GEOHOT_MEM_GUARD_STATE: posix(path.join(dir, "state.at")),
    GEOHOT_MEM_GUARD_SYSTEMCTL: posix(stub),
  };
  return { dir, log, env };
}

test("内存压力过线时重启 api 与 web", async () => {
  const { dir, log, env } = await sandbox("96.00", 2047000, 1200000);
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /pressured full=96 swap=41%：重启 geohot-api geohot-web/);
  const calls = await readFile(log, "utf8");
  assert.match(calls, /^restart geohot-api$/m);
  assert.match(calls, /^restart geohot-web$/m);
  await rm(dir, { recursive: true, force: true });
});

test("swap 过线也算过线", async () => {
  const { dir, log, env } = await sandbox("3.00", 2047000, 600000);
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /pressured full=3 swap=70%/);
  assert.match(await readFile(log, "utf8"), /restart geohot-api/);
  await rm(dir, { recursive: true, force: true });
});

test("冷却期内不重复动手", async () => {
  const { dir, log, env } = await sandbox("96.00", 2047000, 1200000);
  await run("bash", [SCRIPT], { env });
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /刚重启过，等冷却/);
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.length, 2, "第二次不该再调用 systemctl");
  await rm(dir, { recursive: true, force: true });
});

test("没有压力时一根手指都不碰", async () => {
  const { dir, log, env } = await sandbox("2.50", 2047000, 2020000);
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /^ok full=2 swap=1%/);
  await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});
