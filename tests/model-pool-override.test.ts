// 后台「调整池顺序」（`setCapabilityPool`）写进去的是逗号列表；运行期必须按它派发。
// 2026-11-27 现场：英文腿的池首被写成 agnes-3.0-flash-cn，流量却全落在主 agnes 上——
// `readOverrides()` 当时用 `known(value)` 只认单个注册表名，逗号列表被整条忽略，
// 后台显示的顺序与真实派发从来不是一回事。这里把「池顺序真的被读到」钉成一条测试。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelSources, invalidateModelCache } from "@aihot/backend/editorial/models";

const KEY = "models.english";
let saved: string | null = null;

after(async () => {
  if (saved === null) await sql`DELETE FROM settings WHERE key = ${KEY}`;
  else await sql`UPDATE settings SET value = ${sql.json({ model: saved })} WHERE key = ${KEY}`;
  invalidateModelCache();
  await closeDb();
});

test("后台写入的池顺序（逗号列表）会被运行期读到，不是被整条忽略", async () => {
  const [row] = await sql<{ model: string | null }[]>`SELECT value->>'model' AS model FROM settings WHERE key = ${KEY}`;
  saved = row?.model ?? null;

  const pool = ["agnes-3.0-flash-cn", "dots3-note-prev", "default"];
  await sql`
    INSERT INTO settings (key, value, updated_by) VALUES (${KEY}, ${sql.json({ model: pool.join(",") })}, 'test:pool-override')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  invalidateModelCache();

  const sources = await modelSources();
  assert.equal(sources.english!.source, "admin", "池顺序写进 settings 后，来源就该是 admin");
  assert.equal(sources.english!.model, pool.join(","), "读回来的必须仍是那一串顺序，不能被压成单个名字");

  // 认不出的成员被丢掉，但不连累整条覆盖：留下的仍是能派发的那几个。
  await sql`UPDATE settings SET value = ${sql.json({ model: "not-a-model,default" })} WHERE key = ${KEY}`;
  invalidateModelCache();
  const cleaned = await modelSources();
  assert.equal(cleaned.english!.model, "default", "认不出的成员要过滤掉，认得的要留下");
});
