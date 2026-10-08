// 期号落库（`reports.issue_no`，迁移 0048）：报眼的「第 N 期」在发布时盖一次章，不再由读取层的
// 下标倒推（docs/known-issues.md「站点已部署」第 5 条——超过最新 400 期的窗口，倒推的号会消失）。
// 这里钉住六件事：发布盖章且逐期递增、空刊不占号、重排保号、读层把号带给页面（含往期栏导航）、
// 迟到的旧刊不插队占号（后面的期先编了号，它就没有号）。
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
import { listReports, loadReport, reportNavigation } from "@aihot/backend/publication/reports";

const T = tag();
const SOURCE = `test-report-no-${T}`;
// 私有的窗口：这一期由北京日期命名，窗口是它前一天的 08:00 到当天 08:00。键取 2100-01，在所有别的
// 测试文件的夹具键之上（它们最高用到 2099-12）——「迟到」的判定看的是全库比它更新的已编号期，
// 键落在别人下面的话，别的文件先跑一轮就把这两条测试判成迟到。
const DAY1 = "2100-01-14";
const DAY2 = "2100-01-15";
const EMPTY = "2100-01-16";
const LATE = "2100-01-17";
const DAY3 = "2100-01-18";
const INSIDE1 = new Date("2100-01-13T06:00:00Z");
const INSIDE2 = new Date("2100-01-14T06:00:00Z");
const INSIDE_LATE = new Date("2100-01-16T06:00:00Z");
const INSIDE3 = new Date("2100-01-17T06:00:00Z");

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
  // releasedAt 必须比真实时钟早：期键取在 2100 年（见上方注释），而读取层的门 itemHasPage 看的是
  // visible_after ≤ 真实 now——放行时刻写「现在」这条报纸才读得开；时间线仍在 2100 的窗口里，
  // candidates 的归属规则（visible_after ≤ timeline_at 时按 timeline_at）会把它分进对应的期。
  const published = await publishArticle(articleId, { now: inside, releasedAt: new Date() });
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
  await sql`DELETE FROM receipts WHERE subject IN ${sql([`report:daily:${DAY1}`, `report:daily:${DAY2}`, `report:daily:${LATE}`, `report:daily:${DAY3}`])}`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key IN ${sql([DAY1, DAY2, EMPTY, LATE, DAY3])}`;
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

test("迟到的旧刊不插队：后面的期先编了号，它就没有号", async () => {
  // 05-19 正常出刊（先拿到号），然后 01-17 才被补出来（那一天失败过、这是 catch-up 的路）。
  // 系列按 key 排序计数（迁移 0048 也按 key 序回填），所以补出来的旧刊不能顶着更大的号印一个更早的日期。
  await item("c", `塔克拉玛干沙漠边缘林带二期开工 ${T}`, INSIDE3);
  const m = await maxNo();
  await composeDaily(DAY3, "test");
  assert.equal(await issueNoOf(DAY3), m + 1, "正常出刊的一期照旧拿号");

  await item("d", `祁连山北麓春季融雪径流偏丰 ${T}`, INSIDE_LATE);
  await composeDaily(LATE, "test");
  assert.equal(await issueNoOf(LATE), null, "来得比后面那期晚的旧刊不占号");
});

// 读层这一条放在最后，且只建一次索引：reportIndex 是进程内缓存（60 秒新鲜期），测试一秒钟内跑完，
// 中途再喊一次 listReports 读到的还是旧快照——放进来的顺序要和这份缓存的行为一致，而不是去和它斗。
test("读层把号带出来：列表与往期栏导航携带 no（含迟到的旧刊与空刊的对照）", async () => {
  const entries = await listReports("daily");
  const day1 = entries.find((e) => e.key === DAY1);
  assert.ok(day1, "这两期是读得开的报纸，必须在索引里");
  assert.equal(day1!.no, await issueNoOf(DAY1));
  assert.equal(entries.find((e) => e.key === EMPTY), undefined, "空刊不在读者索引里");
  assert.equal(entries.find((e) => e.key === DAY3)?.no, await issueNoOf(DAY3), "后出的那期带着号");
  const late = entries.find((e) => e.key === LATE);
  assert.ok(late, "迟到的旧刊仍然是一期读得开的报纸（有引注就进索引）");
  assert.equal(late!.no, null, "只是没有号：印日期，不说自己是第几期");

  // 往期栏导航与报眼共用同一条目形状——导航丢了号，每一期的报眼都会跟着丢。
  const nav = reportNavigation("daily", entries, DAY1);
  const day1Nav = nav.find((e) => e.key === DAY1);
  assert.ok(day1Nav, "导航里有这一期");
  assert.equal(day1Nav!.no, await issueNoOf(DAY1), "导航条目不丢号——报眼读的就是它");
});

// 这一条必须排在最后：`loadReport` 里的 neighbors() 会走 listReports，从而预热读取层那 60 秒的
// 期次索引缓存（lib/cache.ts），排在别人前面就会让上面那条"读层把号带出来"读到旧索引。
test("空刊自己也要知道自己没出刊：`readable` 与读取层那道门同一个判据", async () => {
  // 归档把那一天叫「未出刊」，指名点开它仍是 200 的诚实空态（既有决定）。报眼此前只看窗口关没关，
  // 于是这一页一边是空版面、一边写着「每天 08:00 出刊」——一个事实两个答案。
  const blank = await loadReport("daily", EMPTY);
  assert.ok(blank, "空刊按地址仍可打开");
  assert.equal(blank!.readable, false, "版面没有可读条目，readable 必须是 false");
  const real = await loadReport("daily", DAY1);
  assert.equal(real!.readable, true, "有条目有页面的那期必须是 true，否则报眼会对正常的期说未出刊");
});
