// 后台各页的版式由 kit 决定：页头、卡片、表格的间距与宽度只在这里改一次（2026-11-08 站长要求优化布局）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ui = readFileSync("apps/web/app/features/admin/ui.tsx", "utf8");

test("页头在桌面端吸顶，正文有统一的纵向节奏", () => {
  assert.ok(ui.includes("wide = false"), "宽表页要有显式的宽档");
  assert.ok(ui.includes("max-w-[1680px]"), "宽档 1680");
  assert.ok(ui.includes("max-w-[1320px]"), "阅读宽度 1320");
  assert.ok(ui.includes("lg:sticky lg:top-0"), "页头桌面端吸顶");
  assert.ok(ui.includes('<div className="space-y-5">{children}</div>'), "卡片之间统一 20px 节奏");
});

test("卡片与表格留白一致，长表可扫读", () => {
  assert.ok(ui.includes("p-4 sm:p-5"), "卡片正文在宽屏多 4px");
  assert.ok(ui.includes("even:bg-bg-sunk/25"), "长表斑马纹");
  assert.ok(ui.includes("first:pl-4 last:pr-4"), "首尾列与卡片内边距对齐");
});

test("宽表页真的用了宽档", () => {
  for (const f of ["content", "runs", "server", "audit"]) {
    const page = readFileSync(`apps/web/app/routes/admin/${f}.tsx`, "utf8");
    assert.ok(page.includes("<AdminPage wide title="), `${f} 页要用宽档`);
  }
});
