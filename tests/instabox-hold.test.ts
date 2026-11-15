import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy/geohot/bin/instabox-hold.mjs", import.meta.url), "utf8");
const unit = readFileSync(new URL("../deploy/geohot/systemd/geohot-instabox-hold.service", import.meta.url), "utf8");
const installer = readFileSync(new URL("../deploy/geohot/install-units.sh", import.meta.url), "utf8");

test("保活脚本走 REST /wake，不依赖 InstaBox 的 MCP 网关", () => {
  // 实测 mcp.instabox.sh 不接受我们的 key（401 invalid bearer token），所以只能走 REST
  assert.match(script, /\/v1\/machines\/\$\{machine\}\/wake/);
  assert.doesNotMatch(script, /mcp\./);
  assert.match(script, /Authorization: `Bearer \$\{key\}`/);
});

test("token 只从文件读，不进命令行与日志", () => {
  assert.match(script, /INSTABOX_TOKEN_FILE/);
  assert.match(script, /readFileSync\(tokenFile/);
  // 日志里不许出现 key 本身
  assert.doesNotMatch(script, /console\.log\([^)]*\bkey\b/);
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
