import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 2026-11-06 23:1x 现场：在 891 MB / 2 vCPU 的主库上跑 `npm run build -w @aihot/web`，
 * load 冲到 31、首页 503；部署脚本 `timeout 1500` 到期退出，六个单元一个都没重启，
 * 最后靠手工「本机构建 + scp 制品」才把站点救回来。
 *
 * 结论：构建是开发期的活，不该让生产机承担。`deploy.sh --web-prebuilt` 把这一步挪到部署机，
 * 只把 `apps/web/build` 打成制品传过去。这套断言锁住四条容易回退的形状：
 *   1. 开关存在，并且只对 HEAD 生效（不然传上去的 build 与源码不是同一棵树）；
 *   2. 本地构建必须关掉 MSYS 的路径转换，否则 `BASE_PATH=/geohot` 会变成 `C:/Users/…/geohot`，
 *      装上去就是 2026-11-07 00:2x 那次全站 404；
 *   3. 制品里混进本机路径要当场失败，而不是装上去之后再猜；
 *   4. 远端分支必须真的跳过 `npm run build`，并且仍然把上一版 assets 并回去。
 */
const DEPLOY = new URL("../deploy/geohot/deploy.sh", import.meta.url);
const deploy = readFileSync(DEPLOY, "utf8");

test("prebuilt mode is opt-in and refuses anything but HEAD", () => {
  assert.match(deploy, /PREBUILT="\$\{GEOHOT_WEB_PREBUILT:-0\}"/);
  assert.match(deploy, /--web-prebuilt\) PREBUILT=1 ;;/);
  assert.match(deploy, /--web-prebuilt 只能用于 HEAD/);
});

test("local build disables MSYS path conversion and guards the artifact", () => {
  const start = deploy.indexOf("if (( PREBUILT )); then");
  const end = deploy.indexOf('upload_dir="$(ssh');
  assert.ok(start > 0 && end > start, "找不到本地预构建块");
  const block = deploy.slice(start, end);

  assert.match(block, /MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='\*' BASE_PATH="\$BASE_PATH" npm run build -w @aihot\/web/);
  assert.match(block, /grep -q 'C:\/Users' apps\/web\/build\/server\/index\.js/);
  assert.match(block, /tar czf "\$web_pkg" -C apps\/web build/);
});

test("remote side skips the in-place build when the artifact is present", () => {
  assert.match(deploy, /WEB_PREBUILT='\$\(\[\[ -n "\$web_pkg" \]\] && echo 1 \|\| echo 0\)'/);
  assert.match(deploy, /if \[\[ "\$\{WEB_PREBUILT:-0\}" == "1" \]\]; then/);
  assert.match(deploy, /tar xzf "\$UPLOAD_DIR\/web-build\.tar\.gz" -C "\$APP_ROOT\/apps\/web"/);

  // 预构建分支里不能再出现本机构建：那正是把生产机拖垮的那一步。
  const pre = deploy.indexOf('if [[ "${WEB_PREBUILT:-0}" == "1" ]]; then');
  const els = deploy.indexOf("wait_for_quiet \"构建前\"", pre);
  assert.ok(pre > 0 && els > pre, "找不到预构建分支");
  const block = deploy.slice(pre, els);
  assert.ok(!/npm run build/.test(block), "预构建分支里不该再跑 npm run build");
});

test("old assets are still merged back so open pages do not 404", () => {
  assert.match(deploy, /ASSETS_DIR="\$APP_ROOT\/apps\/web\/build\/client\/assets"/);
  assert.match(deploy, /sudo -n cp -an "\$ASSETS_DIR\.prev\/\." "\$ASSETS_DIR\/"/);
  // 合并逻辑必须在 if/else 之外，两条路径共用一份。
  const merged = deploy.indexOf('if sudo -n test -d "$ASSETS_DIR.prev"; then', deploy.indexOf("WEB_PREBUILT"));
  const els = deploy.indexOf("\nfi\n", deploy.indexOf("WEB_PREBUILT"));
  assert.ok(merged > els, "旧 assets 的合并应该留在两条分支之后");
});
