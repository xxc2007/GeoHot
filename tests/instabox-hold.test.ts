import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy/geohot/bin/instabox-hold.mjs", import.meta.url), "utf8");
const unit = readFileSync(new URL("../deploy/geohot/systemd/geohot-instabox-hold.service", import.meta.url), "utf8");
const installer = readFileSync(new URL("../deploy/geohot/install-units.sh", import.meta.url), "utf8");

test("保活脚本走 REST /wake 与 /exec，不依赖 InstaBox 的 MCP 网关", () => {
  // 实测 mcp.instabox.sh 不接受我们的 key（401 invalid bearer token），所以只能走 REST
  assert.match(script, /\/v1\/machines\/\$\{encodeURIComponent\(MACHINE\)\}\/wake/);
  assert.match(script, /\/v1\/machines\/\$\{encodeURIComponent\(MACHINE\)\}\/exec/);
  assert.doesNotMatch(script, /mcp\./);
  assert.match(script, /authorization: `Bearer \$\{token\}`/);
});

test("token 只从文件读，不进命令行与日志", () => {
  assert.match(script, /INSTABOX_TOKEN_FILE/);
  assert.match(script, /readFile\(TOKEN_FILE, "utf8"\)/);
  assert.doesNotMatch(script, /console\.log\([^)]*\btoken\b/);
});

test("机器不在 running 就叫醒，醒着就定期做一次入向活动", () => {
  // 免费档 30 分钟没人用就暂停，而且这个值改不了（403 spec_not_allowed）
  assert.match(script, /m\.state === "running"/);
  assert.match(script, /async function wake\(\)/);
  assert.match(script, /ACTIVE_MS/);
  assert.match(script, /ensureExecutor\(\)/);
});

test("根盘可能被模板重置，所以执行器从 /data 上的自举脚本装回", () => {
  assert.match(script, /\/data\/geohot-boot\/bootstrap\.sh/);
  assert.match(script, /geohot-exec-tunnel geohot-exec-worker/);
});

test("单元把机器 id 与 token 路径写进环境，且常驻重启", () => {
  assert.match(unit, /Environment=INSTABOX_MACHINE=m_/);
  assert.match(unit, /Environment=INSTABOX_TOKEN_FILE=\/etc\/geohot\/instabox-token/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /StartLimitIntervalSec=0/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/geohot\/bin\/instabox-hold\.mjs/);
});

test("安装清单认得这个单元，否则 verify-config-drift 会报孤本", () => {
  assert.match(installer, /geohot-instabox-hold\.service/);
});

test("被暂停的机器要用 /start 拉起来：/wake 对 suspended 会回 409 machine_not_running", () => {
  // 2026-11-16 实测：suspend 之后调用 /wake 一律 409 "machine is suspended; start it first"
  assert.match(script, /\/v1\/machines\/\$\{encodeURIComponent\(MACHINE\)\}\/start/);
  assert.match(script, /idempotency-key/);
  assert.match(script, /\["suspended", "stopped", "stopping", "unknown"\]/);
  assert.match(script, /const first = suspended \? start : wake;/);
});
