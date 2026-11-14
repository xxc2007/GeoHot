// 2026-11-14 21:25 / 2026-11-15 01:1x / 02:0x 三次部署被慢盘判成失败：
//   · 主库只有一块约 250 IOPS 的盘，后台一开 io some avg10 就是 99；
//   · 页面巡检必然拿到 000/503，于是 RESULT: FAIL，脚本还把 AIHOT_RELEASE 还原回旧提交；
//   · 更糟的是结尾那句「把定时器放回原岗位」带 `|| is-enabled`，运维为了救读者面手工停掉的
//     geohot-archive.timer / geohot-warm-pages.timer 会在每次上线被复活，I/O 立刻再满。
// 两条守卫钉住：定时器只还原「进来时在岗」的那一个；验收前先等 I/O，等不到就跳过巡检而不是假红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

const source = () => readFileSync(path.join(REPO_ROOT, "deploy/geohot/deploy.sh"), "utf8");

test("定时器只还原进来时在岗的那一个，不覆盖运维的运行期决定", () => {
  const text = source();
  assert.ok(
    !/if \(\( TIMER_WAS_ACTIVE \)\) \|\| systemctl is-enabled --quiet geohot-archive\.timer/.test(text),
    "不能再带 `|| is-enabled`：enabled 只说明开机该起，不代表现在该跑",
  );
  assert.match(text, /if \(\( TIMER_WAS_ACTIVE \)\); then\s*\n\s*systemctl start geohot-archive\.timer/);
  assert.match(text, /进来时没在跑，保持不动/, "跳过时要留一句可读的日志");
});

test("验收前有 I/O 闸门：等不到安静就跳过巡检，而不是把慢盘报成部署失败", () => {
  const text = source();
  const guard = text.indexOf("io_some()");
  const verify = text.indexOf('echo "== 验收 =="');
  assert.ok(guard > 0, "应该有 io_some() 读数函数");
  assert.ok(guard < verify, "I/O 闸门要放在验收之前");
  assert.match(text, /while \[ "\$\(io_some\)" -gt 70 \]/);
  assert.match(text, /跳过页面巡检/);
  // 跳过时必须返回 0 并提示手工复跑，否则脚本仍会还原指纹、打印假红的 FAIL。
  const skipBlock = text.slice(guard, verify);
  assert.match(skipBlock, /exit 0/);
  assert.match(skipBlock, /verify-deploy\.sh/);
});
