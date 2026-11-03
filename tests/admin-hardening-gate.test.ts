// 加固门的 fail-closed 超集：只设 AIHOT_ENVIRONMENT=production、NODE_ENV 留 development 的部署
// （docker-compose / 手工路径）也必须过密钥强度与占位符检查。config.ts 的 servesPublicTraffic
// 在模块加载时定值，所以这个用例必须是独立进程（node --test 每文件一进程）且在动态 import 之前
// 就把环境摆好——同进程里改 process.env 不会让已加载的 config 重新求值。
// 本文件刻意不 import ./setup.ts：它在加载期就要求 *_test 库并补齐强密钥，恰好会掩盖弱密钥路径。
process.env.NODE_ENV = "development";
process.env.AIHOT_ENVIRONMENT = "production";
process.env.SITE_URL = "https://example.test";
process.env.SESSION_SECRET = "short";
process.env.IMG_PROXY_SIGN_SECRET = "short";
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-test-credentials";

const { createAdminControl } = await import("../apps/web/admin-control.ts");
const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;

test("AIHOT_ENVIRONMENT=production 单独设置（NODE_ENV=development）也要拒绝弱密钥启动", async () => {
  await assert.rejects(
    () => createAdminControl(),
    /Refusing to start in production: .*SESSION_SECRET/,
  );
  // 两把门都报上：IMG_PROXY_SIGN_SECRET 同样短，说明列表走完了而不是碰巧断在第一个。
  await assert.rejects(
    () => createAdminControl(),
    (error: unknown) => error instanceof Error && /IMG_PROXY_SIGN_SECRET/.test(error.message),
  );
});
