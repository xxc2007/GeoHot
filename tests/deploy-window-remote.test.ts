// 2026-11-05 06:40–06:42：部署刚跑完，r115 闸门把 worker 冻了 10 分钟，日志是
//   FENCED 5xx=6/700s grace=0 worker=deactivating
// `worker=deactivating` 说明 5xx 全是我们自己重启打出来的，而 grace=0 说明排除区间没生效。
// 根因不是"窗口写在本机"（那两行本来就在 `<<'REMOTE'` 里，跑在服务器上），而是闸门只认
// **两个 epoch 都在** 的窗口文件——部署进行中文件里只有开始那个，结束的得等验收前才追加。
// 于是整段重启窗口照计。两条守卫钉住：窗口写在远端块内；单值窗口按"还没关"处理。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("部署窗口写在远端 heredoc 里，跟着服务器执行", () => {
  const lines = read("deploy/geohot/deploy.sh").split("\n");
  const open = lines.findIndex((line) => line.includes("<<'REMOTE'"));
  const close = lines.findIndex((line, i) => i > open && line.trim() === "REMOTE");
  assert.ok(open > 0 && close > open, "deploy.sh 应该有 <<'REMOTE' … REMOTE 远端块");

  const writes = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes("/run/geohot-deploy-window"));
  assert.equal(writes.length, 2, "开始与结束各写一次");
  for (const { line, i } of writes) {
    assert.ok(
      i > open && i < close,
      `窗口必须写在远端块里（本机 Git Bash 没有 /run）：${line.trim()}`,
    );
    assert.match(line, /^date \+%s >+ \/run\/geohot-deploy-window$/, line.trim());
  }
});

test("闸门把只有开始时间的窗口当成还没关", () => {
  const gate = read("deploy/geohot/bin/r115-reader-gate.sh");
  assert.match(gate, /DW=\/run\/geohot-deploy-window/);
  assert.match(
    gate,
    /DE == 0 && DS > 0 && DS >= NOW - WIN - GRACE/,
    "部署进行中只有 DS：右端要按 NOW 补上，否则重启窗口内的 5xx 全算读者事故",
  );
  assert.match(gate, /if \[ -r "\$DW" \]; then/, "窗口可读就该生效，不该藏在 GRACE > 0 里");
  // 2026-11-05 二次复核：文件里是两行（开始、结束各一个 epoch），而 `read -r DS DE < 文件`
  // 只吃第一行 —— 结束那个 epoch 从来没被看见，窗口被当成"还没关"，右端取 NOW。
  assert.match(gate, /DS=\$\(sed -n '1p' "\$DW"/, "开始时间读第一行");
  assert.match(gate, /DE=\$\(sed -n '2p' "\$DW"/, "结束时间读第二行（read 只读第一行，是上一个版本的真 bug）");
  assert.doesNotMatch(gate, /read -r DS DE < "\$DW"/, "别再退回按行读两个字段");
});

test("恢复就绪判据的间隔窗口容得下闸门自己的节律", () => {
  // 唯一调用 reader-recovery-ready.sh 的计时器是 10 分钟一轮；样本间隔写死 150 秒时
  // RELEASE 永远拿不到"两次连续健康"，/run/geohot-r115-gate 永不释放。
  const ready = read("deploy/geohot/bin/reader-recovery-ready.sh");
  const bound = /now-prior <= (\d+)/.exec(ready);
  assert.ok(bound, "脚本里应有 now-prior <= N 的上界");
  assert.ok(Number(bound[1]) >= 600, `上界要容得下 10 分钟一轮的闸门，实际 ${bound?.[1]}`);
});