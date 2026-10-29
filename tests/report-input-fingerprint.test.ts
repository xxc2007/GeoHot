import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily, composeWeekly, reportInput } from "@aihot/backend/reports/compose";
import { refreshWorkflowReadinessTx } from "@aihot/backend/publication/readiness";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });
test("refresh fingerprints track copy, revision, prior coverage and period metrics; unchanged work is free", async () => {
  const source = `report-input-${tag()}`, day = "2016-06-02", prior = "2016-06-01", week = "2016-W22";
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({
    title: "河流地貌观测结果", leadParagraph: "河流地貌研究提供新的观测资料。", highlights: [1],
    headline: "河流地貌观测结果", overview: "河流地貌研究提供新的观测资料。", themes: [],
  }) } }] }));
  const previous = { REPORT_MODEL: process.env.REPORT_MODEL, LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_API_KEY: process.env.LLM_API_KEY };
  const budget = await sql`SELECT * FROM budgets WHERE service='agnes-cn'`;
  Object.assign(process.env, { REPORT_MODEL: "deepseek-flash", LLM_BASE_URL: provider.url, LLM_API_KEY: "local-test-key" });
  let articleId = "", factId: number | undefined;
  const factPublicId = `fact-${source}`;
  async function saved(kind = "daily", key = day) { return (await sql`SELECT revision,content FROM reports WHERE kind=${kind} AND key=${key}`)[0]!; }
  async function cli(args: string[]) {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "false", EMBEDDINGS_ENABLED: "false" } });
    let output = ""; child.stdout.on("data", (d) => { output += String(d); }); child.stderr.on("data", (d) => { output += String(d); });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(code, 0, output); return output;
  }
  try {
    await getBoss();
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('agnes-cn',500,5000,50000)
      ON CONFLICT(service) DO UPDATE SET per_minute=500,per_hour=5000,per_day=50000`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${source},${source},'rss','T1','editorial',true)`;
    articleId = (await upsertMaterial({ sourceId: source, url: `https://example.com/${source}`, title: "River observations",
      publishedAt: new Date("2016-06-01T12:00:00Z"), via: "import", backfill: "archive", bodyStatus: "ok", bodyText: "完整的中文河流地貌观测正文。" })).articleId;
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${articleId},1,'rule','pass','physical','河流地貌观测结果','河流地貌研究提供新的观测资料。',90,true)`;
    await publishArticle(articleId);
    await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
    // A real legacy issue with the same citation IDs must be rebuilt once.
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES('daily',${day},'2016-06-01','2016-06-02',${sql.json({ sections: [{ items: [{ itemId: articleId, title: "旧的河流结果" }] }], flashes: [] })},now(),'manual')`;
    assert.equal((await composeDaily(day, "test", true)).unchanged, undefined);
    assert.equal(provider.hits(), 1);
    const first = await saved(); assert.ok(first.content.generator.inputFingerprint);
    const same = await composeDaily(day, "test", true);
    assert.equal(same.unchanged, true); assert.equal(same.entries, 1);
    assert.equal(provider.hits(), 1); assert.equal((await saved()).revision, first.revision);
    await sql`UPDATE publications SET title='河流地貌观测得到修订结果',summary='新的中文纠错摘要说明河流观测结果。',score=91 WHERE article_id=${articleId}`;
    await sql.begin(tx=>refreshWorkflowReadinessTx(tx,articleId));
    assert.equal((await composeDaily(day, "test", true)).unchanged, undefined);
    assert.equal(provider.hits(), 2); assert.equal((await saved()).content.sections[0].items[0].title, "河流地貌观测得到修订结果");
    const copied = await saved();
    await sql`UPDATE articles SET revision=revision+1 WHERE id=${articleId}`;
    await sql`UPDATE analyses SET input_revision=(SELECT revision FROM articles WHERE id=${articleId}) WHERE article_id=${articleId}`;
    await sql.begin(tx=>refreshWorkflowReadinessTx(tx,articleId));
    assert.equal((await composeDaily(day, "test", true)).unchanged, undefined);
    assert.equal((await saved()).revision, copied.revision + 1);
    assert.equal(provider.hits(), 2, "unchanged actual model brief reuses its paid receipt even when article revision changes");
    const withoutFact = (await reportInput("daily", day)).fingerprint;
    factId = (await sql`INSERT INTO facts(public_id,title) VALUES(${factPublicId},'河流观测事实') RETURNING id`)[0]!.id;
    await sql`UPDATE publications SET fact_id=${factId!} WHERE article_id=${articleId}`;
    await sql.begin(tx=>refreshWorkflowReadinessTx(tx,articleId));
    assert.notEqual((await reportInput("daily", day)).fingerprint, withoutFact);
    await composeDaily(day, "test", true);
    assert.equal((await saved()).content.sections[0].items[0].factId, factPublicId);
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES('daily',${prior},'2016-05-31','2016-06-01',${sql.json({ sections: [], flashes: [{ itemId: "different-prior-item", factId: factPublicId }] })},now(),'manual')`;
    const repeated = await composeDaily(day, "test", true);
    assert.equal(repeated.entries, 0); assert.equal(repeated.unchanged, undefined);
    assert.deepEqual((await saved()).content.sections, []); assert.equal(provider.hits(), 2);
    const empty = await saved();
    assert.equal((await composeDaily(day, "test", true)).unchanged, true);
    assert.equal((await saved()).revision, empty.revision); assert.equal(provider.hits(), 2);
    // CLI refresh must react to dependency changes while citation IDs are identical.
    await sql`UPDATE reports SET content=${sql.json({ sections: [], flashes: [] })} WHERE kind='daily' AND key=${prior}`;
    await cli(["scripts/backfill-papers.ts", `--from=${day}`, `--to=${day}`, "--kinds=daily", "--refresh", "--apply", "--database-url-env=DATABASE_URL"]);
    assert.equal((await saved()).content.sections[0].items[0].itemId, articleId);
    const restored = await saved(), hits = provider.hits();
    const revisions = (await sql`SELECT count(*)::int AS n FROM report_revisions`)[0]!.n;
    const unchanged = await cli(["scripts/backfill-papers.ts", `--from=${day}`, `--to=${day}`, "--kinds=daily", "--refresh", "--apply", "--database-url-env=DATABASE_URL"]);
    assert.match(unchanged, /输入及依赖完全相同/);
    await cli(["scripts/recompose-report.ts", "--kind=daily", `--key=${day}`, "--skip-unchanged", "--apply"]);
    await cli(["scripts/recompose-report.ts", "--kind=daily", `--key=${day}`, "--skipUnchanged", "--apply"]);
    assert.equal((await saved()).revision, restored.revision); assert.equal(provider.hits(), hits);
    assert.equal((await sql`SELECT count(*)::int AS n FROM report_revisions`)[0]!.n, revisions);
    await sql`UPDATE publications SET summary='译文更新后的河流观测摘要。' WHERE article_id=${articleId}`;
    await sql.begin(tx=>refreshWorkflowReadinessTx(tx,articleId));
    await cli(["scripts/recompose-report.ts", "--kind=daily", `--key=${day}`, "--skip-unchanged", "--apply"]);
    assert.equal((await saved()).revision, restored.revision + 1);
    assert.equal((await saved()).content.sections[0].items[0].summary, "译文更新后的河流观测摘要。");
    await composeWeekly(week, "test", true);
    const weekly = await saved("weekly", week), input = await reportInput("weekly", week);
    assert.equal((await composeWeekly(week, "test", true)).unchanged, true);
    await sql`DELETE FROM reports WHERE kind='daily' AND key=${prior}`;
    assert.notEqual((await reportInput("weekly", week)).fingerprint, input.fingerprint);
    assert.equal((await composeWeekly(week, "test", true)).unchanged, undefined);
    const changed = await saved("weekly", week);
    assert.equal(changed.revision, weekly.revision + 1);
    assert.equal(changed.content.metrics.reportsCovered, weekly.content.metrics.reportsCovered - 1);
  } finally {
    await sql`DELETE FROM reports WHERE (kind='daily' AND key IN (${day},${prior})) OR (kind='weekly' AND key=${week})`;
    await sql`DELETE FROM receipts WHERE subject IN (${'report:daily:'+day},${'report:weekly:'+week})`;
    await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=${articleId}`;
    await sql`DELETE FROM publications WHERE article_id=${articleId}`;
    await sql`DELETE FROM analyses WHERE article_id=${articleId}`;
    await sql`DELETE FROM article_discoveries WHERE article_id=${articleId}`;
    await sql`DELETE FROM article_revisions WHERE article_id=${articleId}`;
    await sql`DELETE FROM articles WHERE source_id=${source}`; await sql`DELETE FROM sources WHERE id=${source}`;
    if (factId !== undefined) await sql`DELETE FROM facts WHERE id=${factId}`;
    await sql`DELETE FROM budgets WHERE service='agnes-cn'`;
    for (const b of budget) await sql`INSERT INTO budgets ${sql(b)}`;
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await provider.close();
  }
});
