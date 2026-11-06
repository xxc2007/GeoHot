import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 2026-11-06 19:1x 现场：主库（891MB / 2 vCPU）起 worker 60 秒后 load 19.4、首页 /geohot/ 20 秒超时；
 * 换 coordinator 角色也在 000/3.5s 之间横跳；停掉立刻回到 0.03–0.14 秒。所以「主库只做读者面」
 * 是长期形态，不是临时绕道——它必须落在磁盘上，并且被验收与部署同时认。
 *
 * 这套断言锁的是三件事：
 *   1. verify-deploy 认 /etc/geohot/readers-only，且同时要求 worker 是 disabled（否则重启会自己起来）；
 *   2. 没有标记的机器照旧要求 worker active（不能因为上面的放宽把别的机器蒙混过去）；
 *   3. deploy.sh 在标记在位时不重启 worker，否则每次上线都亲手把读者面打一次。
 */
const VERIFY = new URL("../deploy/geohot/verify-deploy.sh", import.meta.url);
const DEPLOY = new URL("../deploy/geohot/deploy.sh", import.meta.url);
const READERS_ONLY = new URL("../deploy/geohot/bin/readers-only.sh", import.meta.url);

const verify = readFileSync(VERIFY, "utf8");
const deploy = readFileSync(DEPLOY, "utf8");

test("verify-deploy accepts a readers-only node only when worker is also disabled", () => {
  // api/web 是读者面，无论什么形态都必须 active。
  assert.match(verify, /for u in geohot-api geohot-web; do/);
  assert.match(verify, /api\/web 是读者面，必须 active/);
  // 标记文件是唯一的放宽依据。
  assert.match(verify, /sudo -n test -f \/etc\/geohot\/readers-only/);
  // 两道判据缺一不可：跑着判红、enabled 也判红。
  assert.match(verify, /geohot-worker active，但这台机器标了 \/etc\/geohot\/readers-only/);
  assert.match(verify, /下次重启会自己起来/);
  assert.match(verify, /systemctl disable geohot-worker/);
});

test("a machine without the marker still has to run all three units", () => {
  // else 分支必须仍然要求 active：不然这次放宽会把所有机器一起放过。
  // 切 else 分支的原文（从 reader_only 判据到下一节注释之间），别按提示语切：
  // 提示语只出现在 bad 那一行，切片会漏掉同一分支里的 ok。
  const start = verify.indexOf('if [[ -n "$reader_only" ]]; then');
  const end = verify.indexOf("# 另外两条是 2026-10-10 之后加上的链路");
  assert.ok(start > 0 && end > start, "找不到 readers-only 判据块");
  const block = verify.slice(start, end);
  assert.match(block, /\[\[ "\$worker_state" == "active" \]\] && ok "geohot-worker active"/);
  assert.match(block, /没有 \/etc\/geohot\/readers-only 的机器，三单元都要 active/);
});

test("deploy.sh skips geohot-worker under the marker, and only then", () => {
  // 2026-11-06 实测：判据写成本机 sudo 时，在 Windows 上是命令找不到（127），静默跳过，
  // worker 又被拉起来把读者面打到超时。所以标记必须问服务器。
  assert.match(deploy, /if ssh "\$\{ssh_opts\[@\]\}" "\$SSH_TARGET" 'sudo -n test -f \/etc\/geohot\/readers-only' 2>\/dev\/null; then/);
  assert.match(deploy, /\[\[ "\$u" == "geohot-worker" \]\] \|\| KEEP\+=\("\$u"\)/);
  assert.match(deploy, /UNITS=\("\$\{KEEP\[@\]\}"\)/);
  // UNITS 的定义必须在过滤之前（否则 KEEP 从空数组里挑，一个单元都不会重启）。
  assert.ok(deploy.indexOf("UNITS=(geohot-brain") < deploy.indexOf("服务器带标记，本次不重启 geohot-worker"));
  // ssh_opts 必须在过滤之前就绪——否则这行在 dry-run 里也会炸。
  assert.ok(deploy.indexOf("ssh_opts=(") < deploy.indexOf("readers-only"));
});

test("readers-only.sh flips the marker, the unit state and the enable bit together", () => {
  const script = readFileSync(READERS_ONLY, "utf8");
  assert.match(script, /MARKER=\/etc\/geohot\/readers-only/);
  assert.match(script, /systemctl stop geohot-worker/);
  assert.match(script, /systemctl disable geohot-worker/);
  // stop 在 90 秒 TimeoutStopSec 上挂住会留下 failed，面板会显示红点：必须 reset-failed。
  assert.match(script, /systemctl reset-failed geohot-worker/);
  assert.match(script, /systemctl enable geohot-worker/);
  // 只认三个动作，别让人手打错字就把机器定成别的形态。
  assert.match(script, /case "\$\{1:-status\}" in/);
});

test("the night window timer does not resurrect a readers-only worker", () => {
  // 注释里也会出现同样的字样（本轮注释就写了这行命令），先剥注释再判位置。
  const window = readFileSync("deploy/geohot/bin/worker-window.sh", "utf8")
    .split("\n")
    .map(line => line.replace(/^\s*#.*$/, ""))
    .join("\n");
  // 2026-11-07 01:00：夜档定时器不看标记，直接把 worker 起起来，首页 503、部署验收连挂 4 项。
  assert.match(window, /if \[ -e \/etc\/geohot\/readers-only \]; then/);
  const guard = window.indexOf("/etc/geohot/readers-only");
  const fence = window.indexOf("/run/geohot-r115-fence");
  const restart = window.indexOf("systemctl restart geohot-worker");
  assert.ok(guard > 0 && fence > guard, "readers-only 判据要在 fence 判据之前");
  assert.ok(restart > fence, "restart 必须落在两个判据之后的 else 分支里");
});
