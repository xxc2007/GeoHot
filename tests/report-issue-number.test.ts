// 期号落库（`reports.issue_no`，迁移 0048）：报眼的「第 N 期」在发布时盖一次章，不再由读取层的
// 下标倒推（docs/known-issues.md「站点已部署」第 5 条——超过最新 400 期的窗口，倒推的号会消失）。
// 这里钉住四件事：发布盖章且逐期递增、空刊不占号、重排保号、读层把号带给页面。
//
// 号是相对的（max + 1 递增），不是绝对的：同一个测试库里别的文件也在成刊，跨文件谁先跑不确定。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily } from "@aihot/backend/reports/compose";
import { listReports } from "@aihot/backend/publication/reports";

const T = tag();
const SOURCE = `test-report-no-${T}`;
// 私有的过去窗口：这一期由北京日期命名，窗口是它前一天的 08:00 到当天 08:00。库里没有别人写 2022-05。
const DAY1 = "2022-05-15";
const DAY2 = "2022-05-16";
const EMPTY = "2022-05-17";
const INSIDE1 = new Date("2022-05-14T06:00:00Z");
const INSIDE2 = new Date("2022-05-15T06:00:00Z");

let answer: Record<string, unknown> = {};
const provider = await stub(() => ({
  id: `stub-${T}`,
  choices: [{ message: { content: JSON.stringify(answer) } }],
  usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40, brain: { capability: "report", pass: 1, fixture: null, author: null, rule: "rule:list-lead" } },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.REPORT_MODEL = "deepseek-flash";

const ids: string[] = [];
async function item(suffix: string, title: string, inside: Date) {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${suffix}`, title: `Source ${T} ${suffix}`,
    bodyText: "A bulletin.", bodyStatus: "ok", via: "fetch", publishedAt: inside, discoveredAt: inside,
  });
  assert.equal(backfill, false, "这条夹具落进了回填窗口，成刊层根本不会看它");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${title}, ${`${title}的中文摘要。`}, 90, true)`;
  const published = await publishArticle(articleId, { now: inside, releasedAt: inside });
  assert.equal(published?.selected, true, "夹具没有真的入选，后面的断言就都在读一个空版面");
  ids.push(articleId);
}

const issueNoOf = async (key: string) =>
  (await sql<{ issue_no: number | null }[]>`SELECT issue_no FROM reports WHERE kind = 'daily' AND key = ${key}`)[0]?.issue_no;
const maxNo = async () =>
  (await sql<{ m: number }[]>`SELECT coalesce(max(issue_no), 0) AS m FROM reports WHERE kind = 'daily'`)[0]!.m;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, last_ok_at)
            VALUES (${SOURCE}, 'Report numbering', 'rss', 'T1', 'editorial', '2100-01-01', now())`;
  await item("a", `帕米尔高原冰川湖监测站投入运行 ${T}`, INSIDE1);
  await item("b", `塔里木河下游生态输水进入第二周 ${T}`, INSIDE2);
  // 导语会被署名闸门拒掉（fixture 为空、rule 标注），拒掉不影响期号——号看的是版面有没有条目。
  answer = { title: `两条动态 ${T}`, leadParagraph: `本期共 2 条入选动态。`, highlights: [1] };
});

after(async () => {
  await sql`DELETE FROM receipts WHERE subject IN ${sql([`report:daily:${DAY1}`, `report:daily:${DAY2}`])}`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key IN ${sql([DAY1, DAY2, EMPTY])}`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM articles WHERE id = ANY(${ids})`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("发布盖章：两期按刊期递增", async () => {
  const base = await maxNo();
  await composeDaily(DAY1, "test");
  assert.equal(await issueNoOf(DAY1), base + 1, "第一期应拿到当前系列的下一个号");
  await composeDaily(DAY2, "test");
  assert.equal(await issueNoOf(DAY2), base + 2, "按刊期递增，不是按日期差");
});

test("空刊不占号：没有条目的那期留空", async () => {
  await composeDaily(EMPTY, "test");
  assert.equal(await issueNoOf(EMPTY), null, "空刊不是一期读者能翻开的报纸，不消耗期号");
  const rows = (await sql<{ issue_no: number | null }[]>`SELECT issue_no FROM reports WHERE kind='daily' AND key = ${EMPTY}`)[0];
  assert.ok(rows !== undefined, "空刊本身照旧入库——读取层的门负责不把它当报纸");
});

test("重排保号：内容换版，号不动", async () => {
  const beforeNo = await issueNoOf(DAY1);
  const [before] = await sql<{ revision: number }[]>`SELECT revision FROM reports WHERE kind='daily' AND key = ${DAY1}`;
  await composeDaily(DAY1, "test-recompose");
  const [afterRow] = await sql<{ revision: number; issue_no: number | null }[]>`SELECT revision, issue_no FROM reports WHERE kind='daily' AND key = ${DAY1}`;
  assert.ok(afterRow!.revision > before!.revision, "重排确实发生了（版次前进）");
  assert.equal(afterRow!.issue_no, beforeNo, "期号是印章，不是每次排版的产物");
});

test("读层把号带出来：列表条目携带 no", async () => {
  const entries = await listReports("daily");
  const day1 = entries.find((e) => e.key === DAY1);
  assert.ok(day1, "这两期是读得开的报纸，必须在索引里");
  assert.equal(day1!.no, await issueNoOf(DAY1));
  assert.equal(entries.find((e) => e.key === EMPTY), undefined, "空刊不在读者索引里");
});
