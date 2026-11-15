import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.resolve("deploy/geohot/bin/vacuum-maintenance.sh");

/**
 * 2026-11-16 现场：这个「凌晨窗口」以满速读 2.8 GB 的 `receipts`，跑了一个半小时，
 * io 全程 99、load 30+，读者面 `/all` 掉到 10 秒。下面两条用例钉住护栏：
 * 盘已经忙就跳过，真跑起来也必须带上让路的成本参数。
 */
const posix = (value: string) => value.replace(/\\/g, "/");

async function sandbox(ioAvg10: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "vacuum-"));
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const log = path.join(dir, "psql.log");
  const stub = path.join(dir, "bin", "psql");
  await writeFile(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(posix(log))}\nprintf 'PGOPTIONS=%s\\n' "\${PGOPTIONS:-}" >> ${JSON.stringify(posix(log))}\n`);
  await chmod(stub, 0o755);
  const ioFile = path.join(dir, "io");
  await writeFile(ioFile, `some avg10=${ioAvg10} avg60=1.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  const env = {
    ...process.env,
    GEOHOT_VACUUM_IO_FILE: posix(ioFile),
    GEOHOT_VACUUM_RUN_AS: "",
    GEOHOT_VACUUM_PSQL: posix(stub),
    GEOHOT_VACUUM_DB: "geohot",
  };
  return { dir, log, env };
}

test("盘已经忙的时候，一个表都不碰", async () => {
  const { dir, log, env } = await sandbox("98.99");
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /-- skip receipts: io some avg10=98.99 已经到 60/);
  assert.match(stdout, /-- skip admin_model_attempt_metrics/);
  await assert.rejects(readFile(log, "utf8"), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test("真跑的时候必须带 vacuum_cost_delay / statement_timeout", async () => {
  const { dir, log, env } = await sandbox("3.20");
  const { stdout } = await run("bash", [SCRIPT], { env });
  assert.match(stdout, /== vacuum receipts io=3.2/);
  const text = await readFile(log, "utf8");
  assert.match(text, /PGOPTIONS=-c vacuum_cost_delay=20 -c vacuum_cost_limit=200 -c statement_timeout=1800000 -c lock_timeout=30s/);
  assert.match(text, /VACUUM \(ANALYZE, SKIP_LOCKED, VERBOSE\) receipts/);
  await rm(dir, { recursive: true, force: true });
});
