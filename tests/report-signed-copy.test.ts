// 成刊层的署名闸门：日报导语、周报/月报的大标题与总述是这份报纸开口说话的那几句，所以它们和条目稿、
// 事件综述受同一条约束（`editorial/provenance.ts`：读者可见的成稿只能出自 `tooling/fixtures/*.jsonl`
// 里署过名的那一份）。这一层是全仓最后一条没有这道判断的链路——2026-10-05 数生产库：四条成刊调用
// 全部来自规则（`rule:list-lead` ×3、`rule:list-themes` ×1），零条有署名；两条"导语"就是把当天的标题
// 重抄一遍，周报的"主题句"是把条目编号列出来。
//
// 拒绝之后版面并不缺形状（11 期日报里 9 期本来就是 `lead: null`）：条目一条不少，主题退回本报自己的
// 分栏，期名退回通用名；拒绝的原因记在 `content.generator` 上，后台据此列出还等签名的版面。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily, composeWeekly } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `test-report-gate-${T}`;
// A private window in the past: an issue is named by the Beijing date it serves, and its window is the
// 24 hours before that date's 08:00. Nothing else in this database writes 2021-03-14.
const ISSUE = "2021-03-15";
const INSIDE = new Date("2021-03-14T06:00:00Z");
const WEEK = "2021-W10";

type Brain = { fixture?: string | null; author?: string | null; rule?: string | null } | null;
let answer: Record<string, unknown> = {};
let brain: Brain = null;

const provider = await stub(() => ({
  id: `stub-${T}`,
  choices: [{ message: { content: JSON.stringify(answer) } }],
  usage: {
    prompt_tokens: 20, completion_tokens: 20, total_tokens: 40,
    // 成刊的两步共用一份出处标记：`machineRuleOf` 只看 fixture / author / rule，不看是哪个能力答的。
    ...(brain ? { brain: { capability: "report", pass: 1, ...brain } } : {}),
  },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.REPORT_MODEL = "deepseek-flash";

const ids: string[] = [];
/** One 精选 item with signed Chinese copy, inside the window under test. */
async function item(suffix: string, title: string, category: string | null) {
  // `discoveredAt` travels with `publishedAt`: an item found long after it was written is a backfill row,
  // and the paper does not print ordinary backfills (`candidates()`: NOT p.backfill, with the one
  // exception of archive material, which is attributed to its own day — tests/archive-paper-rule.test.ts).
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${suffix}`, title: `Source ${T} ${suffix}`,
    bodyText: "A bulletin.", bodyStatus: "ok", via: "fetch", publishedAt: INSIDE, discoveredAt: INSIDE,
  });
  assert.equal(backfill, false, "这条夹具落进了回填窗口，成刊层根本不会看它");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${title}, ${`${title}的中文摘要。`}, 90, true)`;
  const published = await publishArticle(articleId, { now: INSIDE, releasedAt: INSIDE });
  assert.equal(published?.selected, true, "夹具没有真的入选，后面的断言就都在读一个空版面");
  ids.push(articleId);
  return articleId;
}

const contentOf = async (kind: string, key: string) =>
  (await sql<{ content: Record<string, any> }[]>`SELECT content FROM reports WHERE kind = ${kind} AND key = ${key}`)[0]?.content;

/**
 * Make the next call a genuinely new request. `providers/llm.ts` answers a repeat from the completed
 * receipt of the same logical key — the same cache `tests/story-digest.test.ts` has to work around — so
 * without this the second case below reads the first case's answer and proves nothing about the second.
 */
const fresh = async (subject: string) => {
  await sql`DELETE FROM receipts WHERE subject = ${subject}`;
};
const LEAD_SUBJECT = `report:daily:${ISSUE}`;
const PERIOD_SUBJECT = `report:weekly:${WEEK}`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, last_ok_at)
            VALUES (${SOURCE}, 'Report gate', 'rss', 'T1', 'editorial', '2100-01-01', now())`;
  await item("a", `赣江上游出现洪水，沿岸水文站发布预警 ${T}`, "physical");
  await item("b", `新版基础地形图对外提供，空间数据库同步升级 ${T}`, "geotech");
});

after(async () => {
  // The receipts are this file's own state: leaving a completed answer behind makes the next run read it
  // instead of the stub, which is the failure mode `fresh` exists to avoid.
  await sql`DELETE FROM receipts WHERE subject IN ${sql([LEAD_SUBJECT, PERIOD_SUBJECT])}`;
  await sql`DELETE FROM reports WHERE (kind = 'daily' AND key = ${ISSUE}) OR (kind = 'weekly' AND key = ${WEEK})`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM articles WHERE id = ANY(${ids})`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("规则拼出来的导语不发布：版面退回无导语态，条目一条不少", async () => {
  await fresh(LEAD_SUBJECT);
  brain = { fixture: null, author: null, rule: "rule:list-lead" };
  answer = { title: `赣江上游出现洪水，沿岸水文站发布预警 ${T}`, leadParagraph: `本期共 2 条入选动态：赣江上游出现洪水；自然资源部发布新版基础地形图。`, highlights: [1, 2] };
  await composeDaily(ISSUE, "test");
  const content = await contentOf("daily", ISSUE);
  assert.equal(content!.lead, null, "机器拼的“导语”不替换无导语态");
  assert.deepEqual(content!.highlights, [], "哪几条排头同样是编辑判断，一起退回读取层自己的规则（分数前三）");
  assert.equal(content!.generator.leadRule, "rule:list-lead", "拒绝的原因要能被列出来，不是静默丢弃");
  assert.equal(content!.sections.flatMap((s: any) => s.items).length, 2, "条目一条不少：被拒的只是那句话");
  assert.ok(String(content!.sections[0].items[0].summary).includes("中文摘要"), "条目自己的中文稿照旧在版面上");
});

test("署名的导语照常发布", async () => {
  await fresh(LEAD_SUBJECT);
  brain = { fixture: `report_lead-${T}`, author: `编辑${T}`, rule: null };
  answer = { title: `两站读数并列，赣江防汛进入关键期 ${T}`, leadParagraph: `上游两台水文站同一天给出读数，沿江四站已启动加密监测。`, highlights: [1, 2] };
  await composeDaily(ISSUE, "test");
  const content = await contentOf("daily", ISSUE);
  assert.equal(content!.lead!.leadParagraph, answer.leadParagraph, "有人签名的句子照发，闸门不拦它");
  assert.equal(content!.highlights.length, 2, "焦点由那份稿子指定");
  assert.ok(content!.highlights.every((id: string) => ids.includes(id)), "选出来的仍是这一期的条目");
  assert.equal(content!.generator.leadRule, null, "签名稿不留拒绝记录");
});

test("非中文的导语同样不发", async () => {
  await fresh(LEAD_SUBJECT);
  brain = { fixture: `report_lead-${T}`, author: `编辑${T}`, rule: null };
  answer = { title: `Gan river flood warning ${T}`, leadParagraph: "Gan river flood warning issued for four hydrological stations.", highlights: [] };
  await composeDaily(ISSUE, "test");
  const content = await contentOf("daily", ISSUE);
  assert.equal(content!.lead, null, "签了名但是英文，也还是不能当本报导语");
  assert.equal(content!.generator.leadRule, "no-signed-copy", "记的是没有可用的中文稿，不是某个规则");
  // 形状对而内容不能用：收据不能停在「已收到好答案」上，否则下一次重组这一期白拿同一句英文，
  // 永远等不到能用的那句（`providers/llm.ts` 的 `usable`）。
  const receipt = (await sql<{ status: string; error: string }[]>`SELECT status, error FROM receipts WHERE subject = ${LEAD_SUBJECT} ORDER BY id DESC LIMIT 1`)[0];
  assert.equal(receipt.status, "failed", "被拒收的英文导语不是可复放的好答案");
  assert.match(String(receipt.error), /answer refused/);
});

test("规则写的周报主题退回本报的分栏：条目和分栏留着，句子不发", async () => {
  await fresh(PERIOD_SUBJECT);
  brain = { fixture: null, author: null, rule: "rule:list-themes" };
  answer = {
    headline: "",
    overview: `本期覆盖 2021-03-08 至 2021-03-14，共 2 条入选动态，分 1 个主题列出。`,
    themes: [{ heading: "主题", summary: `本主题 2 条（条目 1、2），按入选分数排列。`, refs: [1, 2] }],
  };
  await composeWeekly(WEEK, "test");
  const content = await contentOf("weekly", WEEK);
  assert.equal(content!.overview, undefined, "机械总述不发");
  assert.equal(content!.headline, undefined, "没有大标题，期名退回通用名");
  assert.equal(content!.generator.proseRule, "rule:list-themes", "拒绝记在期上");
  const themes = content!.themes as Array<{ heading: string; summary: string | null; storyRefs: unknown[] }>;
  // Sorted: both entries carry the same score, and `sectionsOf` walks the reading order, so which of the
  // paper's two sections comes first is the tie-break, not the thing under test.
  assert.deepEqual(themes.map((t) => [t.heading, t.summary]).sort(), [["学科", null], ["技术", null]], "退回本报自己的分栏：栏目名来自词表，不是机器写的句子");
  assert.equal(themes.reduce((n, t) => n + t.storyRefs.length, 0), 2, "这一期选出来的条目一条都没丢");
});

test("署名稿里指名了本期条目没提过的机构，大标题不发、总述照发", async () => {
  await fresh(PERIOD_SUBJECT);
  brain = { fixture: `report_period-${T}`, author: `编辑${T}`, rule: null };
  answer = {
    headline: `粮农组织发布全球农业灾害预警 ${T}`,
    overview: `上游来水与沿线预警构成本期主要线索，两条动态分别来自水文与测绘两条线。`,
    themes: [{ heading: "水情", summary: `两台站读数并列，防汛进入关键期。`, refs: [1] }, { heading: "测绘", summary: `新版基础地形图对外提供。`, refs: [2] }],
  };
  await composeWeekly(WEEK, "test");
  const content = await contentOf("weekly", WEEK);
  assert.equal(content!.headline, undefined, "身份守卫：条目里没有这家机构，标题就不能指名它");
  assert.equal(content!.overview, answer.overview, "总述与主题仍是有署名、有中文的稿子，不因一句话被拒而整期作废");
  assert.equal(content!.generator.proseRule, null, "这一期没有退回规则");
  assert.equal((content!.themes as Array<{ heading: string }>)[0].heading, "水情", "署名的主题名保留，不被分栏名替换");
});
