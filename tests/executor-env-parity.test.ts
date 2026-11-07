import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(import.meta.dirname, "..");

// 2026-11-06/07 两次事故都是「线上手工改了 .env，仓库脚本没改」：
// 一台机器被 systemd 的 Environment= 盖回 2 个名额，另一台的翻译钉着 12 个已死的模型键。
// 重建机器会一分不差地回到坑里。这两条断言要求仓库脚本本身就带齐这些键。
const SCRIPTS = [
  "deploy/geohot/second-node/bootstrap4-window.sh",
  "deploy/geohot/third-node/setup-exec.sh",
];

const REQUIRED = [
  "Environment=GEOHOT_RESOURCE_PROFILE=balanced",
  "Environment=GEOHOT_PRESSURE_LOAD_PER_CPU=6",
  "Environment=GEOHOT_PRESSURE_MEMORY_FULL=60",
  "Environment=GEOHOT_PRESSURE_IO_FULL=80",
  "Environment=GEOHOT_PRESSURE_CPU_SOME=95",
  "Environment=GEOHOT_PRESSURE_AVAILABLE_MIB=48",
  "Environment=TRANSLATE_MODEL=dots3-note-prev",
  "Environment=GEOHOT_INTAKE_LANES=combined",
  // TimeoutStopSec 是 [Service] 指令，不是 Environment= 行；90 秒默认值会把在飞的分析强杀成僵尸。
  "TimeoutStopSec=600",
];

for (const script of SCRIPTS) {
  test(`${script} 自带调度与翻译所需的全部环境键`, async () => {
    const text = await readFile(path.join(ROOT, script), "utf8");
    const missing = REQUIRED.filter((key) => !text.includes(key));
    assert.deepEqual(missing, [], `${script} 缺少：${missing.join(" / ")}`);
  });
}
