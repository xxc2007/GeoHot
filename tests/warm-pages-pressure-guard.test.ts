import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.resolve("deploy/geohot/bin/warm-pages.sh");

/**
 * 2026-11-16：主库被换页压死的那半小时里，预热带还在每分钟给冷缓存点一次火。
 * 这条用例钉住「机器忙就先别预热」这道闸，以及它不会把正常的 200 误判成故障。
 */
const posix = (value: string) => value.replace(/\\/g, "/");

async function sandbox(ioSome: string, memFull: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "warm-"));
  const io = path.join(dir, "io");
  const mem = path.join(dir, "mem");
  await writeFile(io, `some avg10=${ioSome} avg60=1.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  await writeFile(mem, `some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=${memFull} avg60=1.00 avg300=1.00 total=9\n`);
  return {
    dir,
    env: {
      ...process.env,
      GEOHOT_WARM_IO_FILE: posix(io),
      GEOHOT_WARM_MEM_FILE: posix(mem),
      GEOHOT_WARM_PATHS: "/geohot/",
    },
  };
}

test("盘被读满时预热直接让路", async () => {
  const { dir, env } = await sandbox("99.01", "96.50");
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /-- skip: io some avg10=99.01 memory full avg10=96.50/);
  await rm(dir, { recursive: true, force: true });
});

test("内存被换出到线上时也让路（盘还没满）", async () => {
  const { dir, env } = await sandbox("12.00", "55.00");
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /-- skip: /);
  await rm(dir, { recursive: true, force: true });
});

test("机器不忙时不拦（这一步会真的去请求，所以断言只看没有 skip）", async () => {
  const { dir, env } = await sandbox("3.00", "2.00");
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.doesNotMatch(stdout, /-- skip: /);
  await rm(dir, { recursive: true, force: true });
});

test("阈值可以用环境变量调", async () => {
  const { dir, env } = await sandbox("30.00", "10.00");
  const { stdout } = await run("bash", [SCRIPT], { env: { ...env, GEOHOT_WARM_MAX_IO: "10" } });
  assert.match(stdout, /-- skip: io some avg10=30.00 .*（线 10\/40）/);
  await rm(dir, { recursive: true, force: true });
});

test("注释里要留下为什么", async () => {
  const text = await readFile(SCRIPT, "utf8");
  assert.match(text, /proxy_cache_use_stale/);
  assert.match(text, /memory full avg10=96/);
});
