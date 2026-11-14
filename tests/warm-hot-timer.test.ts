// 2026-11-15 04:0x 实测：后台流水线一开，`/geohot/` 的冷算就是 2.4–4.2 秒，而 nginx 的 HTML 缓存
// 只有 60 秒。2 分钟一轮的预热带盖不住这个窗口，于是首页每分钟至少有一次真读者替全站付冷算的钱。
// 这里钉住「首页与『全部』另有一条 60 秒的预热带」，并把路径做成可覆盖，方便临时只热一屏。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("预热脚本支持 GEOHOT_WARM_PATHS 覆盖，默认仍是五屏", () => {
  const script = read("deploy/geohot/bin/warm-pages.sh");
  assert.match(script, /GEOHOT_WARM_PATHS/);
  assert.match(script, /read -r -a PATHS/);
  for (const p of ["/geohot/", "/geohot/all?tab=all", "/geohot/hot", "/geohot/daily", "/geohot/topics"]) {
    assert.ok(script.includes(`"${p}"`), `默认路径缺 ${p}`);
  }
});

test("首页与「全部」有 60 秒一轮的独立预热带", () => {
  const unit = read("deploy/geohot/systemd/geohot-warm-hot.service");
  assert.match(unit, /GEOHOT_WARM_PATHS=\/geohot\/ \/geohot\/all\?tab=all/);
  assert.match(unit, /IOSchedulingClass=idle/);
  const timer = read("deploy/geohot/systemd/geohot-warm-hot.timer");
  // 只有 OnUnitActiveSec 时 list-timers 显示 NEXT n/a —— 这条坑 2026-11-14 踩过一次。
  assert.match(timer, /OnCalendar=\*-\*-\* \*:\*:00/);
  assert.match(timer, /OnUnitActiveSec=55s/);
});

test("新单元登记进安装清单，否则 verify-config-drift 会报孤本", () => {
  const install = read("deploy/geohot/install-units.sh");
  assert.match(install, /geohot-warm-hot\.service/);
  assert.match(install, /geohot-warm-hot\.timer/);
});
