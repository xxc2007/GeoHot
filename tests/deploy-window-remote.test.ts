// 2026-11-05 06:42 复核：部署刚结束，r115 闸门照样 FENCED 10 分钟，日志里 `worker=deactivating`、
// `grace=0`。两处同时坏了：
//   1. deploy.sh 的 `date +%s > /run/geohot-deploy-window` 跑在操作者机器上（Windows Git Bash 没有
//      /run），服务器那份从来没被写过——mktemp 之后 `grep -c .` 是 0；
//   2. 闸门把"读部署窗口"藏在 `if (( GRACE > 0 ))` 里，于是关掉按单元时间戳算的宽限，会连带
//      关掉唯一可靠的排除手段。
// 这两条都是"看不出坏了"的静默失效，所以用静态守卫钉住：文件在，写法就得在。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("部署窗口写在服务器上，不是操作者机器上", () => {
  const deploy = read("deploy/geohot/deploy.sh");
  const writes = deploy.split("\n").filter((line) => line.includes("/run/geohot-deploy-window"));
  assert.ok(writes.length >= 2, "deploy.sh 应该写两次窗口（开始 / 结束）");
  for (const line of writes) {
    assert.match(
      line,
      /ssh .*sudo tee (?:-a )?\/run\/geohot-deploy-window/,
      `窗口只能通过 ssh 写到服务器，本机写等于没写：${line.trim()}`,
    );
  }
});

test("闸门读部署窗口不依赖 GRACE", () => {
  const gate = read("deploy/geohot/bin/r115-reader-gate.sh");
  assert.match(gate, /DW=\/run\/geohot-deploy-window/, "闸门要知道窗口文件在哪");
  assert.ok(
    !/GRACE > 0 \)[^\n]*\[ -r "\$DW" \]/.test(gate),
    "窗口不能藏在 GRACE > 0 里面：关宽限不等于关掉部署排除",
  );
  assert.match(gate, /if \[ -r "\$DW" \]; then/, "窗口可读就该生效");
});