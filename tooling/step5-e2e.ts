// step-5-preview 能不能干本站日常的全部活：拿一条**真材料**（不是夹具）走 GEOHOT 自己的
// analyzeArticle，十一个能力变量逐个点名 `workbuddy-step5-preview`，看它能不能真的走完整条链，
// 并把每一个环节的收据（service / model / 用量 / 时延）逐条打出来核对。
//
// 与 tooling/wbprobe-e2e.ts 的关系：那一份只换 MODEL_POOL=workbuddy-hy3 一个变量；
// 这一份用 .env.step5 叠层把 11 个能力变量逐个写成 step-5-preview，为「方方面面」逐环节留痕。
// 用 .env + .env.step5 两层环境起；自己开一条源、跑完自己清干净，不留数据在库里。
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { modelFor } from "@aihot/backend/editorial/models";

const TAG = `step5-${Date.now().toString(36)}`;
const SOURCE = `step5-src-${TAG}`;

// 一条真实的地理热点材料：2020–2025 青藏高原冰川质量变化整编数据集发布。
// 数字、机构、方法都是这条新闻里真会出现的形状，专门考验模型会不会照抄、会不会漏掉关键量级。
const TITLE = "第二次青藏科考发布 2020–2025 青藏高原冰川质量变化数据集：整体亏损速率较上一个五年加快约 1.7 倍";
const BODY = `第二次青藏高原综合科学考察研究团队联合中国科学院青藏高原研究所，于 10 月 9 日发布“2020–2025 青藏高原冰川质量变化数据集”。

该数据集整合了 ICESat-2 卫星测高、GRACE-FO 重力卫星与 42 个地面观测点的冰川物质平衡记录，覆盖青藏高原及周边帕米尔、天山、喜马拉雅等 12 个山系，时间分辨率为逐年、空间分辨率 500 米。

数据显示，2020–2025 年青藏高原冰川整体物质平衡为 −0.62 米水当量/年，而 2015–2020 年为 −0.36 米水当量/年，亏损速率加快约 1.7 倍。其中帕米尔—西昆仑地区亏损最慢（−0.28 米水当量/年），喜马拉雅中段最快（−0.94 米水当量/年）。

研究团队同时估算，冰川融水对长江源区径流的贡献率已从 2000 年代的 9.4% 上升至近五年的 15.1%，在夏季枯水期这一比例更高。数据集已在国家青藏高原科学数据中心开放下载，采用 CC BY 4.0 许可。

团队负责人表示，这一版数据集首次把重力卫星与激光测高的系统性偏差做了统一订正，因此与上一版相比，喜马拉雅地区的亏损估计上修了约 12%。`;

// analyzeArticle 覆盖的五个能力：prefilter / score / structure / understand / summarize。
// 其余六个能力（group / groupReview / digest / report / translate / monitor）由别处的 worker 任务触发，
// 这里先把它们各自解析成谁，确认配置本身生效。
const ANALYZE_CAPS = ["prefilter", "score", "structure", "understand", "summarize"] as const;
const OTHER_CAPS = ["group", "groupReview", "digest", "report", "translate", "monitor"] as const;

async function main() {
  const resolved: Record<string, string> = {};
  for (const cap of [...ANALYZE_CAPS, ...OTHER_CAPS]) {
    resolved[cap] = await modelFor(cap, TAG);
  }
  console.log("能力 → 模型：");
  for (const [cap, model] of Object.entries(resolved)) console.log(`  ${cap.padEnd(12)} ${model}`);
  console.log("");

  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode)
    VALUES (${SOURCE}, 'step-5 实测源', 'rss', 'T1', 'editorial')`;

  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${TAG}`,
    title: TITLE,
    bodyText: BODY,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });

  console.log(`材料 ${articleId}\n`);

  const started = Date.now();
  const result = await analyzeArticle(articleId);
  const elapsed = Date.now() - started;

  const [row] = await sql<Record<string, unknown>[]>`
    SELECT relevance, selected, score, title_zh, summary_zh, reason_zh, category, tags, subjects, model
    FROM analyses WHERE article_id = ${articleId} ORDER BY id DESC LIMIT 1`;

  const receipts = await sql<Record<string, unknown>[]>`
    SELECT purpose, service, model, status, attempts,
           (response->'workbuddy'->>'latencyMs')::int AS ms,
           (usage->>'prompt_tokens')::int AS prompt_tokens,
           (usage->>'completion_tokens')::int AS completion_tokens,
           (usage->'completion_tokens_details'->>'reasoning_tokens')::int AS reasoning_tokens,
           (usage->>'credit')::numeric AS credit,
           error
    FROM receipts WHERE subject = ${`article:${articleId}@1`} ORDER BY id`;

  const onStep5 = receipts.filter((r) => r.service === "workbuddy" && r.model === "step-5-preview");
  console.log(JSON.stringify({
    tag: TAG,
    elapsedMs: elapsed,
    resolved,
    output: result?.output ?? null,
    row,
    receipts,
    receiptCount: receipts.length,
    onStep5Count: onStep5.length,
  }, null, 2));

  console.log(`\n收据共 ${receipts.length} 条，其中 service=workbuddy 且 model=step-5-preview 的 ${onStep5.length} 条。`);
  if (receipts.length === 0) console.log("⚠️  没有任何收据：MODEL_CALLS_ENABLED 没开，或模型解析回落到了 default（brain stub）。");
  else if (onStep5.length !== receipts.length) {
    console.log("⚠️  有收据没落在 step-5-preview 上，逐条比对上面的 receipts 数组。");
  } else {
    console.log("✅ 这一步链上的每一次调用都落在 step-5-preview 上。");
  }

  await sql`DELETE FROM analyses WHERE article_id = ${articleId}`;
  await sql`DELETE FROM receipts WHERE subject = ${`article:${articleId}@1`}`;
  await sql`DELETE FROM articles WHERE id = ${articleId}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  console.log(`\n已清理 ${TAG}`);
  await closeDb();
  process.exit(0);
}

await main();
