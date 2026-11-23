// `/en` 的期次索引不能先截 400 期再筛英文：英文期次较稀时，更早的英文刊面会被中文期次挤出窗口。
// 这里把两期“只有中文”的日报放在更早的一期英文日报之上，并要求 `listReports('daily', 2, 'en')`
// 仍然找到那一期英文：修复前 `readableRows` 先 slice(0,2) 再过滤，结果为空。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { listReports } from "@aihot/backend/publication/reports";

const T = tag();
const NEWEST = "2099-12-31";
const MIDDLE = "2099-12-30";
const ENGLISH = "2099-12-29";
const ITEM = "enverify-zh-m71";

after(async () => {
  await sql`DELETE FROM reports WHERE key IN (${NEWEST}, ${MIDDLE}, ${ENGLISH})`;
  await closeDb();
});

/** A daily issue that prints one available item; only the English one carries `content_en`. */
async function insertReport(key: string, english: boolean) {
  const content = {
    lead: { title: `日报 ${key}`, leadParagraph: "这是测试日报的导语。" },
    sections: [{ label: "自然地理", items: [{ itemId: ITEM, title: "西藏南部地震", sourceUrl: "https://example.com/x" }] }],
    flashes: [],
  };
  const contentEn = english
    ? {
      lead: { title: `Daily ${key}`, leadParagraph: "A test daily lead." },
      sections: [{ label: "Physical geography", summary: null }],
      citations: [{ itemId: ITEM, title: "Magnitude 7.1 earthquake in southern Tibet", summary: "The network recorded the quake at 06:12.", sourceName: "CENC", role: "lead" }],
    }
    : null;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, content_en, generated_at, origin, revision, revision_en)
            VALUES ('daily', ${key}, now() - interval '1 day', now(), ${sql.json(content)}, ${contentEn ? sql.json(contentEn) : null}, now(), 'manual', 1, ${english ? 1 : null})`;
}

test("英文索引在有英文稿的期次里取窗口，不会被更新的中文期次挤掉", async () => {
  await insertReport(NEWEST, false);
  await insertReport(MIDDLE, false);
  await insertReport(ENGLISH, true);

  const entries = await listReports("daily", 2, "en");
  const keys = entries.map((e) => e.key);
  assert.ok(keys.includes(ENGLISH), `英文期次不在索引里：${keys.join(", ")}（测试标签 ${T}）`);
  assert.equal(entries.length, 1);
});