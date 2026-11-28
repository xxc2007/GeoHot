import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const conf = readFileSync(new URL("../deploy/geohot/nginx/28-geohot-public-admission.conf", import.meta.url), "utf8");
const snippetUrl = new URL("../deploy/geohot/nginx/geohot-public-admission.conf", import.meta.url);
const deploy = readFileSync(new URL("../deploy/geohot/deploy.sh", import.meta.url), "utf8");

test("后台与接口不再借读者的 2r/s 桶（magpie 面板一次要几十个资源）", () => {
  // 2026-11-16 现场：/geohot/admin/magpie 只有导航栏，控制台 setLocale/setTab is not defined，
  // 一次加载 42 条网络里有 19 条 429；根因是面板资源落进了读者的 burst=12 桶。
  assert.match(conf, /map "\$request_method:\$uri" \$geohot_admin_exempt \{/);
  assert.match(conf, /~?\^?\(GET\|HEAD\):\/geohot\/\(admin\|api\/admin\|api\/mcp\|api\/img-proxy\|api\/health\)\(/);
  assert.match(conf, /map "\$geohot_dynamic_slot:\$geohot_reader_exempt\$geohot_admin_exempt" \$geohot_reader_key/);
  assert.match(conf, /~:1\[01\]\$ "";/);
  assert.match(conf, /~:01\$ "";/);
});

test("真实读者与静态资源仍然按访客计数，回环豁免没被改坏", () => {
  assert.match(conf, /~:1\$|~:1\[01\]\$ "";/);
  assert.match(conf, /default \$binary_remote_addr;/);
  assert.match(conf, /geo \$geohot_reader_exempt \{/);
  assert.match(conf, /127\.0\.0\.1\/32 1;/);
  // 2026-11-28：2r/s 对「一个读者 + 列表 prefetch」太紧，正常浏览会被自己的数据请求打回 429。
  assert.match(conf, /limit_req_zone \$geohot_reader_key zone=geohot_reader_rate:1m rate=10r\/s;/);
});

test("读者数据接口与 .data 不占 HTML 的桶（prefetch 不该把自己限速）", () => {
  assert.match(conf, /~?\^?\(GET\|HEAD\):\/geohot\/api\/site\/\(timeline\|pool\|hot\|calendar\|meta\|stats\|changelog\|topics\)\(/);
  assert.match(conf, /~?\^?\(GET\|HEAD\):\/geohot\/\.\*\\\.data\$/);
});

test("入口限制的片段进了仓库，读者侧是 10r/s + burst 30", () => {
  assert.ok(existsSync(snippetUrl), "deploy/geohot/nginx/geohot-public-admission.conf 应当在仓库里");
  const snippet = readFileSync(snippetUrl, "utf8");
  assert.match(snippet, /limit_conn geohot_dynamic_conns 16;/);
  assert.match(snippet, /limit_req zone=geohot_reader_rate burst=30 nodelay;/);
});

test("conf.d 里的同名副本也要跟着仓库走，否则改仓库线上不变", () => {
  assert.match(deploy, /\[ -f "\/etc\/nginx\/conf\.d\/\$base" \] && dests\+=/);
  assert.match(deploy, /cp -a "\$dest" "\/root\/nginx-snippet-backup\/\$base\.\$\(date \+%s\)"/);
  assert.match(deploy, /done <"\$touched"/);
});
