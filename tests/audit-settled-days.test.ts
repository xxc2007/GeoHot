// 「这一天判完了没有」这条判据自己的用例。
//
// 为什么值得单独钉：这次回填的完工定义就压在这句话上——日子判完了却没出刊，是"漏印"还是"那天真没内容",
// 全部差别都在 `unsettled` 那两笔里。第二笔（`analyzed` 但没有 `publications` 行）以前被漏数过一次，
// 那一天就在缺一条本该入刊的故事的情况下出了刊，而下一轮还会说"已出刊"（`backfill-papers.ts` 的注释
// 记着这次）。这条判据从此只有一份，那就必须有一行代码证明两种形态都算未结算。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { dailyWindow } from "@aihot/backend/reports/compose";
import { settledDays } from "../scripts/lib/settled-days.ts";

const T = tag();
const DAY = "2031-05-06";
const SOURCE = `audit-settled-${T}`;
const ID = `audit-settled-${T}`;
// 期次日 D 覆盖 [D-1 08:00, D 08:00) 北京时间，所以 D 这一天材料的时间戳落在 D-1。
// 窗口从 `dailyWindow()` 取而不是这里手写日期：写死过一次，结果用例把条目塞进了邻日窗口，
// `settledDays` 按口径正确地认不出 D，三条断言一起红——那种红看不出是谁错。
const WINDOW = dailyWindow(DAY);
const AT = new Date(Number(WINDOW.start) + 6 * 3600_000);

async function insertPublication() {
  await sql`
    INSERT INTO publications (article_id, title, summary, url, source_id, channel, visibility, selected, eligible,
                              published_at, discovered_at, timeline_at, sort_at, backfill, updated_at)
    VALUES (${ID}, ${`判完的日子 ${T}`}, ${`这一天的提要 ${T}`}, ${`https://example.org/${T}`}, ${SOURCE},
            'news', 'public', true, true, ${AT}, ${AT}, ${AT}, ${AT}, false, now())
    ON CONFLICT (article_id) DO UPDATE SET visibility = 'public', selected = true, eligible = true, backfill = false`;
}

let seeded = false;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Settled-day test', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status,
                                  published_at, timeline_at, discovered_at, processing_state, updated_at)
            VALUES (${ID}, ${SOURCE}, ${ID}, ${`https://example.org/${T}`}, ${`判完的日子 ${T}`},
                    ${`正文 ${T}`.repeat(30)}, 'ok', ${AT}, ${AT}, ${AT}, 'analyzed', now())`;
  await insertPublication();
  seeded = true;
});

after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${DAY}`;
  if (seeded) {
    await sql`DELETE FROM publications WHERE article_id = ${ID}`;
    await sql`DELETE FROM articles WHERE id = ${ID}`;
    await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  }
  await closeDb();
});

const inRange = (onlyWithoutEdition = false) => settledDays(sql, DAY, DAY, onlyWithoutEdition);

test("判完且投影齐了的日子算已结算，出了刊就不必再出现在嫌疑名单里", async () => {
  assert.deepEqual(await inRange(), [DAY], "analyzed + 有 publications 行应当算结算完");
  assert.deepEqual(await inRange(true), [DAY], "结算完但没有期次 = 嫌疑日（这一天有候选，见 audit 脚本）");
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', ${DAY}, ${new Date(`${DAY}T00:00:00Z`)}, ${AT},
                    ${sql.json({ sections: [], flashes: [] } as never)}, now(), 'model')
            ON CONFLICT (kind, key) DO UPDATE SET window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
              content = EXCLUDED.content, generated_at = EXCLUDED.generated_at`;
  assert.deepEqual(await inRange(), [DAY], "结算状态不因出了刊而变");
  assert.deepEqual(await inRange(true), [], "有了期次就不该再被说成漏印");
});

test("两种未结算都要认：还没判的，和判完了但投影没跑成的", async () => {
  await sql`UPDATE articles SET processing_state = 'new' WHERE id = ${ID}`;
  assert.deepEqual(await inRange(), [], "`new` 那天不能算结算完");
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${ID}`;
  assert.deepEqual(await inRange(), [DAY], "回到基线：analyzed + 有投影 = 结算完");
  await sql`DELETE FROM publications WHERE article_id = ${ID}`;
  assert.deepEqual(await inRange(), [], "analyzed 却没有 publications 行 = 还没结算（这一笔以前被漏数过一次）");
  await insertPublication();
  assert.deepEqual(await inRange(), [DAY], "投影补上后重新算结算完");
});

test("blocked 与 failed 是终态，不挡日子结算", async () => {
  for (const state of ["blocked", "failed"]) {
    await sql`UPDATE articles SET processing_state = ${state} WHERE id = ${ID}`;
    assert.deepEqual(await inRange(), [DAY], `${state} 不该把这一天永远钉住：挡日的一律等，就没有日子能出刊`);
  }
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${ID}`;
});
