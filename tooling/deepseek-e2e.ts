// End-to-end proof that deepseek-v4.1-flash @ max can carry the site's real analysis chain.
//
// This runs the site's OWN `runAnalysis` (prefilter -> two scores -> understand OR summarize -> structure)
// against the local bridge on 3065, which holds the same international WorkBuddy account production's bridge
// does. Nothing here re-implements the pipeline; the point is to see the receipts the site itself writes.
//
//   node --env-file=.env --env-file=.env.deepseek tooling/../<this file>
// (run it from the repo root with the env overlay below, so DATABASE_URL and the valves are the site's)
//
// Env overlay it expects (not committed — .gitignore excludes .env.*):
//   DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot
//   MODEL_CALLS_ENABLED=true
//   COLLECT_ENABLED=false
//   MODEL_POOL=workbuddy-deepseek-flash
//   WORKBUDDY_BASE_URL=http://127.0.0.1:3065/v1
//   WORKBUDDY_API_KEY=local-workbuddy
import { sql } from "@aihot/backend/db";
import { modelFor, modelSources } from "@aihot/backend/editorial/models";
import { runAnalysis } from "@aihot/backend/editorial/analyze";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";

const ARTICLE_ID = process.argv[2];
if (!ARTICLE_ID) throw new Error("usage: <script> <articleId>");

// The site's own loader: the analysis input is assembled in one place, and a probe that re-wrote that query
// would be testing a different article than the worker analyses.
const article = await loadAnalyzeInput(ARTICLE_ID);
if (!article) throw new Error(`no article ${ARTICLE_ID}`);

console.log("=== who serves each capability ===");
const sources = await modelSources();
for (const [key, v] of Object.entries(sources)) console.log(`  ${key.padEnd(14)} ${v.model.padEnd(28)} serving=${v.serving}`);

console.log("\n=== the model this article's steps will actually ask ===");
for (const cap of ["prefilter", "score", "understand", "summarize", "structure"] as const) {
  console.log(`  ${cap.padEnd(12)} ${await modelFor(cap, ARTICLE_ID)}`);
}

console.log("\n=== running the real analysis chain ===");
const started = Date.now();
const run = await runAnalysis(article, { attemptTag: `deepseek-e2e-${Date.now()}` });
console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify({
  prefilter: run.prefilter && { label: run.prefilter.label, model: run.prefilter.model },
  scores: run.scores && { values: run.scores.values, threshold: run.scores.threshold, refused: run.scores.refused, model: run.scores.model },
  writing: run.writing && { kind: run.writing.kind, model: run.writing.model, titleZh: run.writing.titleZh, summaryZh: run.writing.summaryZh?.slice(0, 120), refusal: run.writing.refusal },
  structure: run.structure && { model: run.structure.model, category: run.structure.category, tags: run.structure.tags },
}, null, 2));

console.log("\n=== receipts this run wrote (the site's own ledger) ===");
const receipts = await sql`
  SELECT r.purpose, r.service, a.model, a.status, a.latency_ms,
         (a.usage::jsonb->>'completion_tokens')::int AS completion,
         (a.usage::jsonb->'completion_tokens_details'->>'reasoning_tokens')::int AS reasoning,
         left(coalesce(a.error, ''), 80) AS error
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id
   WHERE r.subject LIKE ${`article:${ARTICLE_ID}%`}
   ORDER BY r.id DESC, a.id DESC LIMIT 20`;
for (const r of receipts) {
  console.log(`  ${r.purpose.padEnd(20)} ${r.service}/${r.model} ${r.status.padEnd(9)} ${String(r.latency_ms).padStart(7)}ms ` +
    `completion=${r.completion} reasoning=${r.reasoning}${r.error ? ` ERR=${r.error}` : ""}`);
}

const truncated = receipts.filter((r) => /finish_reason: length/.test(r.error ?? "")).length;
const failed = receipts.filter((r) => r.status === "failed").length;
console.log(`\n==== verdict ====`);
console.log(`receipts=${receipts.length} failed=${failed} truncated=${truncated}`);
await sql.end();
