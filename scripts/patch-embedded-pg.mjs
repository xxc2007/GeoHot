// 给 embedded-postgres 打运行时补丁：库内部 spawn postgres.exe 时没带 windowsHide，而本机
// 开发库走 detached 守护进程（自身无控制台），Windows 会给 console 子进程新建控制台——
// 就是你看到的那个 D:\geohot-embedded-postgres 黑框（2026-11-02）。npm ci 会重装本库覆盖
// 掉手改，所以挂在 postinstall 上，每次依赖安装后自动重打。幂等：已打过就跳过。
import { readFileSync, writeFileSync } from "node:fs";

const file = "node_modules/embedded-postgres/dist/index.js";
let source;
try {
  source = readFileSync(file, "utf8");
} catch {
  // 依赖没装（比如在 CI 只装了部分 workspace），安静退出。
  process.exit(0);
}
const NEEDLE = "windowsHide: true, env: Object.assign(Object.assign({}, process.env), { LC_MESSAGES: locale })";
if (source.includes("windowsHide: true")) {
  console.log("patch-embedded-pg: already patched");
  process.exit(0);
}
const FROM = '{ env: Object.assign(Object.assign({}, process.env), { LC_MESSAGES: locale }) }';
if (!source.includes(FROM)) {
  console.error("patch-embedded-pg: pattern drifted upstream — inspect node_modules/embedded-postgres/dist/index.js manually");
  process.exit(0); // 不阻塞安装；黑框是小困扰，坏掉安装是大事。
}
writeFileSync(file, source.replace(FROM, '{ windowsHide: true, env: Object.assign(Object.assign({}, process.env), { LC_MESSAGES: locale }) }'));
console.log("patch-embedded-pg: postgres.exe spawn now windowsHide");
