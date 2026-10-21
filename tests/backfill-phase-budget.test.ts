// 档案周期的出刊阶段每 15 分钟被 `timeout` 掐一次。掐在付费调用中间不是"这次没跑完"，而是把那一期永久钉住：
// 收据停在 pending → 清扫器判成 unknown → unknown 按设计不再自动重发（可能已经计费，`providers/receipts.ts`），
// 于是那一期再也发不出来。2026-10-13 实测：`papers` 连续 14 轮全部 exit=124，库里已经钉住两期
// （daily 2026-02-28、2026-03-13）。修法是脚本自己按周期给的预算提前收工——**一次调用都别开在刀刃上**。
//
// 这个文件守的正是那一句：预算不够时必须"零请求出门"。所以判据不是读日志措辞，而是数真正不可伪造的两件事：
// 桩化-provider 的命中数与收据行数。
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stub, tag } from "./setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const T = tag();
const SOURCE = `test-phase-budget-${T}`;
const ISSUE = "2021-04-15";
const INSIDE = new Date("2021-04-14T06:00:00Z");
const SUBJECT = `report:daily:${ISSUE}`;

const provider = await stub(() => ({
  id: `stub-${T}`,
  choices: [{ message: { content: JSON.stringify({ title: `占位标题 ${T}`, leadParagraph: "占位导语，够长的一段中文说明。", highlights: [1] }) } }],
  usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
}));
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";
process.env.REPORT_MODEL = "deepseek-flash";

/**
 * Run the operator script the way the cycle does — a child process, with only the phase budget changed.
 * Deliberately **without** `--env-file=.env`: that file would shadow both the stub endpoint and the
 * throwaway `DATABASE_URL` this test sets, and the run would spend real calls against the dev database
 * while asserting nothing.
 *
 * `MODEL_CALLS_ENABLED` is pinned to true rather than inherited: the child must reach the stub, and an
 * exported `false` in the dev shell would otherwise make the 600-second control fail for a reason that
 * has nothing to do with the guard (the same trap `tests/translate-shutdown.test.ts` pins against).
 *
 * And deliberately **not** `spawnSync`: the provider stub is an HTTP server in *this* process, and a
 * synchronous spawn freezes the event loop that serves it — the control case below would sit waiting for
 * an answer from a stub that cannot answer, and time out looking like a broken guard.
 */
function runPapers(phaseSeconds: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/backfill-papers.ts", `--from=${ISSUE}`, `--to=${ISSUE}`, "--kinds=daily",
        "--apply", "--database-url-env=DATABASE_URL"],
      { cwd: repoRoot, env: { ...process.env, GEOHOT_PHASE_SECONDS: phaseSeconds, MODEL_CALLS_ENABLED: "true" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.on("data", (c: string) => { out += c; });
    const kill = setTimeout(() => child.kill(), 90_000);
    child.on("close", (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

const ids: string[] = [];

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, last_ok_at)
            VALUES (${SOURCE}, 'Phase budget', 'rss', 'T1', 'editorial', '2100-01-01', now())`;
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-a`, title: `Source ${T} a`, bodyText: "A bulletin.",
    bodyStatus: "ok", via: "fetch", publishedAt: INSIDE, discoveredAt: INSIDE,
  });
  ids.push(articleId); // Cleanup must know the material even if a later setup assertion fails.
  assert.equal(backfill, false, "夹具落进了回填窗口，成刊层根本不会看它");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${`赣江沿线启动加密监测 ${T}`}, ${`赣江沿线水文站启动加密监测，读数并列。`}, 90, true)`;
  const published = await publishArticle(articleId, { now: INSIDE, releasedAt: INSIDE });
  assert.equal(published?.selected, true, "夹具没有真的入选");
  // `unsettled()` counts a `new` row as still-pending, so a fixture left at `new` makes the runner report
  // 「等 1 条判完」 and it never reaches the branch under test. Real items arrive here via the analyzer.
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
});

after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${ISSUE}`;
  // Only this file's own attempts, and **before** the receipts go away — a table-wide orphan purge would
  // also mop up another file's leaked rows (so its missing cleanup never shows as a failure), and once the
  // receipts are gone there is nothing left to identify this file's attempts by.
  await sql`DELETE FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE subject = ${SUBJECT})`;
  await sql`DELETE FROM receipts WHERE subject = ${SUBJECT}`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM articles WHERE id = ANY(${ids})`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("预算放不下一次完整调用时：零请求出门，这一期留给下一轮", async () => {
  const hits = provider.hits();
  const run = await runPapers("2"); // 2 s 的档期，减去留给单次调用的余量 ⇒ 还没开始就已经超预算
  assert.equal(run.code, 0, `脚本应当正常收尾（不是被掐死），实际输出：${run.out.slice(-400)}`);
  assert.match(run.out, /时间预算（GEOHOT_PHASE_SECONDS=2s/);
  assert.match(run.out, /本轮时间预算用完，这一期没开始/);
  assert.equal(provider.hits(), hits, "一轮被掐的出刊绝不能把请求发到门上：那正是把收据钉成 unknown 的成因");
  const [receipt] = await sql`SELECT count(*)::int AS n FROM receipts WHERE subject = ${SUBJECT}`;
  assert.equal(receipt!.n, 0, "没有收据行才算真的没开过一次付费调用");
  const [row] = await sql`SELECT count(*)::int AS n FROM reports WHERE kind = 'daily' AND key = ${ISSUE}`;
  assert.equal(row!.n, 0, "没跑完的期次不能留下半份版面");
});

test("预算够时守卫不挡路：同一期照常出刊", async () => {
  const run = await runPapers("600");
  assert.equal(run.code, 0, run.out.slice(-400));
  assert.doesNotMatch(run.out, /本轮时间预算用完/);
  assert.ok(provider.hits() > 0, "600 s 的档期里应当真的发出过一次调用");
  const [row] = await sql<{ content: Record<string, any> }[]>`
    SELECT content FROM reports WHERE kind = 'daily' AND key = ${ISSUE}`;
  assert.ok(row, "这一期必须成刊");
  const items = (row.content.sections ?? []).flatMap((s: any) => s.items ?? []);
  assert.equal(items.length, 1, "版面里的那一条入选动态要在");
});
