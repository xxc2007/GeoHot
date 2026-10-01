// tooling/merge-corpus.mjs — 把 tooling/corpus/corpus-*-*.jsonl 的策划片段并进 tooling/fixtures/*.jsonl。
//
// 为什么需要它：语料 agent 只写 tooling/corpus/corpus-<theme>-{materials,brain}.jsonl 片段（见 WAVE1 §6 的并发纪律），
// tooling/fixtures/ 由本脚本唯一写入。片段会陆续增加（hazards/climate 的 brain 还在写），所以脚本必须
// 随时可重跑、可重跑第二次什么都不加（幂等），并且把每一条被拒的线和原因打印出来——每一条拒绝都是一个
// 真实的集成缺陷，不是格式噪音。
//
//   node tooling/merge-corpus.mjs                      并入并写盘（默认）
//   node tooling/merge-corpus.mjs --dry-run --report   只跑校验，不写任何文件
//   node tooling/merge-corpus.mjs --report --json      机器可读的完整报告
//   node tooling/merge-corpus.mjs --strict             再把「值得复核但内容没丢」的项也判为失败（见下）
//
// 两类输出文件：
//   · <corpus-dir>/curated-materials.jsonl   给 scripts/seed-curated.ts 的入库输入
//   · <corpus-dir>/merge-conflicts.md        冲突账本（八节表格，机器可读；非 dry-run 每次都重写）
//
// 退出码分两层（2026-10-01 改的默认，理由在 W2-M3 / 审计第 1 节）：
//   · **默认就拦**：吞掉「不同判断」的行 —— 即 shadowed（同一份材料两行命中，第二行一行都不生效）里
//     loser 的 reply 与生效行不同的那些，以及 collision 里「身份键等价、两份人工判断不同」那种。
//     这两类的共同点是**有人写过的答案在运行时永远不会被读到**，那是内容丢失，不是需要复核的告警；
//     旧默认只打印一行就继续写盘，所以从来没有人拦过。--no-strict-shadows 只留给排障（明知要吞、先出账本）。
//   · --strict 再叠加：warned / 同 id 的片段↔fixture 账目漂移 / 日报周报死针 / 缺 author / 未解码实体。
//     这些是「值得复核但内容没有丢」的条目，默认只写进 merge-conflicts.md 留账。
// 例外：collision 的「同 id」那一种只在答案不同时才记账——同 id 而 match 与 reply（去掉 note/what）逐字
// 相同的行记成 noteDrift，因为 note/what 不答题：门槛每重算一次，scores 的 note 就要集体改写一遍
// （Wave 4 重算 56/59/62 之后 fixture 改了 100 余行 note，全是这一类）。把这类账目漂移也塞进 collision，
// 几十行的名单会盖住真正被吞掉的那一条判断，所以它连 collision 都不进，只进 noteDrift。
//
// 路径都由参数决定，默认相对本仓库推导，绝不写死某台机器的绝对路径：
//   --corpus-dir=<dir>     片段目录，默认 <repo>/tooling/corpus（片段与材料输出都在仓库内，交付清理不砍管道）
//   --fixtures-dir=<dir>   输出 fixture 目录，默认 <repo>/tooling/fixtures
//   --out=<file>           合并材料输出，默认 <corpus-dir>/curated-materials.jsonl（跟着 corpus-dir 落在仓库内）
//   --themes=<a,b>         只处理这些主题片段（默认全部）
//   --discovered-at=<spec> auto（默认）| now | now-2h | <ISO 时间>
//   --dry-run / --report / --json / --no-merge / --no-materials / --help
//
// 校验依据（都是运行时的真实约束，不是这里的偏好）：
//   · 每能力的必填字段与长度上限 = packages/backend/src/editorial/analyze.ts 的 zod schema
//     （fact.title≤80 / object≤160 / tags≤12 / subjects≤6 / editorialJudgment≤400 / titleZh 1-200 /
//      summaryZh 1-4000 且 finalizeCopy 在 >200 字时压缩 → 这里按 ≤200 硬拒、>190 提示）。
//   · 标签合法性 = @aihot/backend 的真实 normalizeTags（它会静默丢弃词表外的标签）+ @aihot/industry
//     的 CATEGORIES/ITEM_TYPES/ENTITIES/CATEGORY_TAGS —— 全部现场 import，taxonomy 一改这里就跟着改。
//   · match 语义 = tooling/brain-stub.ts 的 findFixture：includes/urlIncludes/titleIncludes/textIncludes
//     是「并且」（都必须在整条 user 消息里），queryIncludes 只看新报道段，candidateIncludes 只看候选块，
//     anyIncludes 命中其一即可，notIncludes 必须不出现；**第一行命中生效**，所以顺序就是语义。
//   · scores 的请求里没有网址也没有信源名（analyze.ts buildScoreInput 只给 发布时间/标题/完整正文），
//     因此 scores 行用 urlIncludes/sourceName 一定是死的 → 直接拒。
//   · 信源分级（T1/T1_5/T2）的唯一真值是 industry/sources.json —— 门槛按分级取，运行时读的是数据库里由
//     sources.json 播种的 sources.tier（scripts/seed.ts:41）。片段材料自己抄的 `sourceTier` 只是副本，
//     已经和登记表漂开（Wave 5 实测 20 条），所以这里一律以登记表为准，并把不一致点名成 tierDrift。
//   · fixture 自查（不止片段）：门槛每重算一次，已经并好的存量行不会有人重读，而 stub 恰恰只读存量行。
//     合并跑完后再对 tooling/fixtures/*.jsonl 的最终内容做三件事（见 fixtureAudit）：每行必须有 author
//     （含 dissent 内层）、scores 的 note 里引用的门槛必须是 selection.ts 现值、note 里写的五轴必须按
//     industry/prompts/selection-score.md 的权重行算得出 attentionScore。后两条是「判断与算术必须自洽」的闸门。
//
// 排序：能力文件 → tier（T1 → T1_5 → T2 → 无法判定）→ 主题 → id（数字感知排序，score-a2 在 score-a10 前）。
// tooling 自己写的示例与文件头部注释一律原样保留在最前面（按字节保留原文），新线只追加在后面——
// 因为「第一行命中生效」，把语料线排在既有示例之后是最不意外的行为。追加块内部按上面的确定性键排序，
// 所以重跑两次得到同一个文件。片段作者若依赖「特殊 → 一般」的行序，排序可能改变谁先命中：这种情况
// 一定出现在报告的 shadow 列里（同一份材料被两行同时命中），不会静默发生。
//
// curated-materials.jsonl 是 seed-curated 入库脚本的唯一输入（另一个 agent 拥有那个脚本），因此是
// 严格 JSONL：**没有注释行、没有空行**。字段名归一到 POST /api/ingest/items 的形状（apps/api/src/routes/
// ingest.ts + packages/backend/src/ingest/items.ts 的 ItemIn：title/url/publishedAt/author/raw），
// 每行额外带 sourceId（该接口按源分组投递，合并后必须自带源），并把片段原文整个塞进 raw.geohot。
// discoveredAt 按 WAVE3 §E 的 48 小时历史闸门（materials.ts STALE_ON_DISCOVERY_MS）设置，见 --discovered-at：
//   auto（默认，本脚本的选择）：publishedAt 离 now−2h 不到 46h 的用 now−2h（能证明间隔 < 48h 且留了余量）；
//     更早的材料把 discoveredAt 钉在 publishedAt+2h，让 discoveredAt−publishedAt 恒等于 2h ≤ 48h，
//     这样 decideTimeline 不会打 backfill，isHistorical 为假，材料能进归组/事件/热度。
//   显式 --discovered-at=now-2h 会把这个值套到所有材料（老材料就会变成 historical，用于复现那个坑）。
//   46h 而不是 48h：下游 scripts/seed-curated.ts 只采纳 gap ≤ 48h−LEAD_MS(1h) 的时间对，并按它自己的 anchor
//   重钉整条时间线，超出的退回「按到达时间」——留 2h 余量让这里选的 gap 被原样接住。
//   auto 依赖墙上时钟，所以 curated-materials.jsonl 每次重跑 discoveredAt 会变（设计如此）；要字节可复就
//   传 --discovered-at=<ISO>。tooling/fixtures/*.jsonl 与时间无关，重跑字节不变（已实测幂等）。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "..");

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`用法：node tooling/merge-corpus.mjs [选项]
  --corpus-dir=<dir>      片段目录（默认 <repo>/tooling/corpus）
  --fixtures-dir=<dir>    fixture 目录（默认 <repo>/tooling/fixtures）
  --out=<file>            合并材料输出（默认 <corpus-dir>/curated-materials.jsonl）
  --themes=<a,b>          只处理指定主题
  --discovered-at=<spec>  auto | now | now-2h | <ISO>（默认 auto，见脚本头部注释）
  --dry-run               不写任何文件（也不写 merge-conflicts.md）
  --report                打印 added/skipped/rejected/warned/shadows 明细表
  --rebuild               fixture = tooling 种子行 + 全部片段接受行 重排；片段是语料的唯一真源
                          （整修过片段之后必须用它，否则追加模式会让 fixture 里的旧副本继续答题）
  --strict                再叠加：warned / 同 id 的片段↔fixture 账目漂移 / 死键告警 / 报告死针 / 缺 author / 未解码实体 → 退出码 1
                          （「吞掉不同判断」的行不用加这个开关，默认就退出码 1；见脚本头部）
  --no-strict-shadows     排障用：把默认那道「吞判断」闸门也降成告警，只写账本不拦
  --conflicts-out=<file>  机器可读冲突表（默认 <corpus-dir>/merge-conflicts.md，非 dry-run 一律重写）
  --json                  输出机器可读完整报告     --no-merge 只出材料     --no-materials 只并 fixture`);
  process.exit(0);
}
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const CORPUS_DIR = path.resolve(opt("corpus-dir") ?? path.join(REPO, "tooling", "corpus"));
const FIXTURES_DIR = path.resolve(opt("fixtures-dir") ?? path.join(REPO, "tooling", "fixtures"));
const OUT_FILE = path.resolve(opt("out") ?? path.join(CORPUS_DIR, "curated-materials.jsonl"));
const ONLY_THEMES = opt("themes") ? opt("themes").split(",").map((s) => s.trim()).filter(Boolean) : null;
const DISCOVERED_AT = opt("discovered-at") ?? "auto";
const DRY = flag("dry-run");
const REPORT = flag("report") || flag("json");
const JSON_OUT = flag("json");
const STRICT = flag("strict");
/** 吞掉「不同判断」的行默认就失败（不必 --strict）；--no-strict-shadows 是排障用的降级开关。 */
const STRICT_SHADOWS = !flag("no-strict-shadows");
const REBUILD = flag("rebuild");
const rebuiltDropped = [];      // --rebuild 下被片段当前版本取代的 fixture 旧副本
const CONFLICTS_FILE = path.resolve(opt("conflicts-out") ?? path.join(CORPUS_DIR, "merge-conflicts.md"));
const DO_MERGE = !flag("no-merge");
const DO_MATERIALS = !flag("no-materials");

// ── Live vocabulary: the real functions, never a copy of them ───────────────────────────────
// taxonomy.ts 由别的 agent 拥有，可能正在被改。import 失败时不猜、不改别人的文件：把依赖 taxonomy 的
// 断言降级成「未校验」并照样跑完，退出码 2 提醒重跑。
let normalizeTags = null;
let finalizeCopy = null;
/** 门槛现值只写在 industry/selection.ts（简报与 AGENTS.md 都这么要求），所以这里 import 而不是抄数字。 */
let GATE = { T1: null, T1_5: null, T2: null };
let SELECTION_FLOOR = null;
try {
  const sel = (await import("@aihot/industry/selection")).SELECTION
    ?? (await import(path.join(HERE, "../industry/selection.ts"))).SELECTION;
  if (sel?.thresholds) GATE = { T1: sel.thresholds.T1 ?? null, T1_5: sel.thresholds.T1_5 ?? null, T2: sel.thresholds.T2 ?? null };
  if (sel?.understandFloor != null) SELECTION_FLOOR = sel.understandFloor;
} catch { /* selection.ts 正在被别的 agent 改：拿不到就把闸门断言降级为不检查 */ }
let TAX = { categories: [], itemTypes: [], entities: [], categoryTags: [], topicTags: [], entityTags: [], synonyms: {}, sectionOf: {}, defaultSection: "" };
const taxonomy = { ok: false, error: null };
try {
  // 先走 workspace 包名（@aihot/backend 的 exports 已经把子路径补成 .ts），失败再退回相对路径。
  let vocab;
  let tax;
  let writing;
  try {
    vocab = await import("@aihot/backend/editorial/vocabulary");
    tax = await import("@aihot/industry/taxonomy");
    writing = await import("@aihot/backend/editorial/writing");
  } catch {
    vocab = await import(path.join(HERE, "../packages/backend/src/editorial/vocabulary.ts"));
    tax = await import(path.join(HERE, "../industry/taxonomy.ts"));
    writing = await import(path.join(HERE, "../packages/backend/src/editorial/writing.ts"));
  }
  normalizeTags = vocab.normalizeTags;
  finalizeCopy = writing.finalizeCopy;
  TAX = {
    categories: tax.CATEGORIES.map((c) => c.key),
    itemTypes: [...tax.ITEM_TYPES],
    entities: Object.keys(tax.ENTITIES),
    categoryTags: [...tax.CATEGORY_TAGS],
    topicTags: [...tax.TOPIC_TAGS],
    entityTags: [...tax.ENTITY_TAGS],
    synonyms: tax.TAG_SYNONYMS ?? {},
    // 日报/周报的分节前缀（compose.ts:17-20）：section 标签由 CATEGORIES 决定，不是这里的常量。
    sectionOf: Object.fromEntries(tax.CATEGORIES.map((c) => [c.key, c.section])),
    defaultSection: [...new Set(tax.CATEGORIES.map((c) => c.section))].at(-1) ?? "",
  };
  taxonomy.ok = true;
} catch (error) {
  taxonomy.error = String(error).slice(0, 200);
}

/** 信源登记表（只读）：材料里的 sourceId 是否在 industry/sources.json 里。 */
const SOURCES = (() => {
  try {
    const raw = JSON.parse(readFileSync(path.join(REPO, "industry/sources.json"), "utf8"));
    const list = Array.isArray(raw) ? raw : raw.sources ?? raw.items ?? [];
    return new Map(list.map((s) => [s.id, s]));
  } catch {
    return new Map();
  }
})();

// ── Text plumbing (同一套 norm/clampStr 语义，和 brain-stub 保持一致) ─────────────────────────
// norm() 必须与 tooling/brain-stub.ts:241 逐字符相同：stub 才是运行时真正答题的那个，这里的校验器只要
// 和它不一致，报告就会说「这行会命中」而线上悄悄走兜底。所以 norm 是「运行时真相」，不改。
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
/**
 * normKey() = norm() 再加上「排版形近字符折叠」。它只用于两件事，绝不用于放行：
 *   1. 判定被丢弃的材料副本与胜出副本是不是只差标点/空白（决定该不该合并，见 materialDivergence）；
 *   2. 解释一个死键为什么死（材料在短语中间插了 ’ “ – &nbsp;，子串就断了）。
 * 为什么不能拿它当匹配依据：stub 的 norm 只删空白不折叠，validator 若按折叠放行，就会写出一条
 * 「校验说活、运行时死」的 fixture——那正是 W2-M3 的成因。所以本脚本反过来要求每条身份键都必须
 * 在两种归一化下等价（见下面的标点不变性闸门），把折叠的活儿留给语料本身。
 */
const FOLD_MAP = [
  [/[\u2018\u2019\u201a\u201b\u02bc\u02bb\u00b4\u2032`]/g, "'"], // ‘ ’ ‚ ‛ ʼ ʼ ´ ′ `
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],                    // “ ” „ ″
  [/[\u2013\u2014\u2015\u2212\u00ad]/g, "-"],                    // – — ― − ­
  [/\u2026/g, "..."],                                            // …
  [/\s+/g, ""],                                                  // 含 nbsp \u00a0、thin \u2009、\u202f
];
const FOLDABLE = /[\u2018\u2019\u201a\u201b\u02bc\u02bb\u00b4\u2032`"“”„‟″–—―−…\u00a0\u2009\u202f]/;
const normKey = (s) => { let t = String(s ?? "").toLowerCase(); for (const [re, to] of FOLD_MAP) t = t.replace(re, to); return t; };
/** 找出 needle 与 haystack 在第一处折叠字符上的分歧，用于报告「为什么这个键只在折叠下成立」。 */
function foldDivergence(needle, hay) {
  const n = norm(needle);
  const at = hay.search(new RegExp(n.slice(0, Math.min(n.length, 12)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const probe = at >= 0 ? hay.slice(at, at + n.length + 6) : "";
  const chars = [...new Set([...probe, ...needle].filter((c) => FOLDABLE.test(c)))];
  return chars.length ? chars.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}「${c}」`).join(" ") : "标点/引号";
}
const cps = (s) => Array.from(String(s ?? "")).length;
const cpSlice = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");
const list = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const SENTENCES = (s) => (String(s ?? "").match(/[。！？!?；;]/g) ?? []).length;
const TIERS = ["T1", "T1_5", "T2", "EXCLUDE_MP"];
const tierRank = (t) => (["T1", "T1_5", "T2"].includes(t) ? TIERS.indexOf(t) : 9);

/** 数字感知：score-a2 < score-a10，否则 id 排序会把 a10 排到 a2 前面（片段作者就是按 a1..a16 写的）。 */
function natural(a, b) {
  const pa = String(a).split(/(\d+)/);
  const pb = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== "") return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

const CAPS = new Set(["prefilter", "scores", "understand", "summarize", "structure", "group_batch", "group_pair", "group_signal", "digest", "report_lead", "report_period", "translate_body", "translate_post"]);
/** 这些能力直接对准一份材料；其余（group_batch/group_pair/group_signal/digest/report_lead/report_period）
 *  对准的是合成出来的事件文本，不做材料级歧义判定，改判「能不能命中已策划的事实标题/中文标题」。 */
const MATERIAL_CAPS = new Set(["prefilter", "scores", "understand", "summarize", "structure", "translate_body", "translate_post"]);
const MATCH_KEYS = new Set(["includes", "urlIncludes", "titleIncludes", "textIncludes", "queryIncludes", "candidateIncludes", "anyIncludes", "notIncludes"]);
const RELATIONS = ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"];
const ROLES = ["principal", "observer", "relayer"];
const LABELS = ["PASS", "BLOCK", "UNKNOWN"];
/** 只有 发布时间/标题/完整正文（analyze.ts buildScoreInput），没有 url 与信源名。 */
const SCORE_NO_URL = "scores 的请求里没有网址与信源名（buildScoreInput），这类身份键永远不会命中";

const MAXBODY = 60_000; // writing.ts MAX_BODY_CHARS
const STRUCT_BODY = 7_000; // input.ts buildMaterial truncate(body, 7000)

// ── JSONL reading ─────────────────────────────────────────────────────────────────────────────
function readJsonl(file) {
  const out = { comments: [], data: [], parseErrors: [] };
  if (!existsSync(file)) return out;
  readFileSync(file, "utf8").split(/\r?\n/).forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
      out.comments.push({ text });
      return;
    }
    try {
      out.data.push({ raw: trimmed, obj: JSON.parse(trimmed), line: i + 1 });
    } catch (error) {
      out.parseErrors.push({ line: i + 1, error: String(error).slice(0, 120), raw: trimmed.slice(0, 120) });
    }
  });
  return out;
}

// ── Fragments ─────────────────────────────────────────────────────────────────────────────────
const FRAGMENT = /^corpus-([a-z0-9]+)-(materials|brain)\.jsonl$/;
function inventory(dir) {
  if (!existsSync(dir)) throw new Error(`片段目录不存在：${dir}`);
  const found = readdirSync(dir)
    .map((f) => FRAGMENT.exec(f))
    .filter(Boolean)
    .map((m) => ({ theme: m[1], kind: m[2], file: path.join(dir, m[0]) }));
  return ONLY_THEMES ? found.filter((f) => ONLY_THEMES.includes(f.theme)) : found.sort((a, b) => natural(`${a.theme}-${a.kind}`, `${b.theme}-${b.kind}`));
}

const frags = inventory(CORPUS_DIR);
const materialRows = [];   // {theme, file, line, raw, obj}
const brainRows = [];      // {theme, file, line, raw, obj}
const fragParseErrors = [];
for (const frag of frags) {
  const read = readJsonl(frag.file);
  fragParseErrors.push(...read.parseErrors.map((e) => ({ ...e, file: frag.file })));
  for (const d of read.data) {
    const row = { theme: frag.theme, file: path.basename(frag.file), line: d.line, raw: d.raw, obj: d.obj };
    (frag.kind === "materials" ? materialRows : brainRows).push(row);
  }
}

// ── Material validation ───────────────────────────────────────────────────────────────────────
const materials = [];
const materialRejects = [];
const materialWarns = [];
const tierDrift = [];          // 片段抄的 sourceTier 与 industry/sources.json 现分级不一致（以登记表为准）
const seenMaterialUrl = new Map();
const byUrl = new Map();
const dupCopies = [];
for (const row of materialRows) {
  const bad = [];
  const m = row.obj;
  if (m.kind !== "material") bad.push(`kind 必须是 "material"，实际 ${JSON.stringify(m.kind)}`);
  if (typeof m.sourceId !== "string" || !m.sourceId.trim()) bad.push("sourceId 缺失");
  if (typeof m.url !== "string" || !/^https?:\/\//i.test(m.url.trim())) bad.push("url 必须是 http(s) 绝对地址");
  if (typeof m.title !== "string" || !m.title.trim()) bad.push("title 缺失");
  if (typeof m.bodyText !== "string" || !m.bodyText.trim()) bad.push("bodyText 缺失（没有正文就只能按标题匹配）");
  const pub = new Date(m.publishedAt ?? "");
  if (!m.publishedAt || !Number.isFinite(pub.getTime())) bad.push(`publishedAt 不是合法时间：${JSON.stringify(m.publishedAt)}`);
  if (m.sourceTier != null && !TIERS.includes(m.sourceTier)) {
    bad.push(`sourceTier "${m.sourceTier}" 非法（数据库 CHECK 只允许 ${TIERS.join("/")}；${String(m.sourceTier).includes("T1.5") ? "tier 要写成 T1_5，不是 T1.5" : ""}）`);
  }
  if (m.language != null && !["zh", "en"].includes(m.language)) bad.push(`language "${m.language}" 不是 zh/en`);
  if (m.firstParty != null && typeof m.firstParty !== "boolean") bad.push("firstParty 必须是布尔");
  if (bad.length) {
    materialRejects.push({ ...row, why: bad.join("；"), what: "material" });
    continue;
  }
  const urlKey = m.url.trim().replace(/\/+$/, "");
  if (seenMaterialUrl.has(urlKey)) {
    const kept = byUrl.get(urlKey);
    // 只在「排版形近字符与空白」内不一致 = 折叠后可视作同一份内容；标题或正文的实质分歧才是要策划的冲突。
    const diverge = kept ? [
      kept.title !== m.title ? (normKey(kept.title) === normKey(m.title) ? "title(仅引号/空白差异)" : "title") : null,
      (kept.bodyText ?? "") !== (m.bodyText ?? "")
        ? (normKey(kept.bodyText ?? "") === normKey(m.bodyText ?? "") ? "bodyText(仅引号/空白差异)" : "bodyText")
        : null,
    ].filter(Boolean) : [];
    dupCopies.push({ ...m, at: `${row.file}#L${row.line}`, keptBy: seenMaterialUrl.get(urlKey), diverge });
    materialRejects.push({
      ...row, id: row.obj.id ?? "(无 id)", what: "material(dup)", capability: "material",
      url: urlKey, winner: seenMaterialUrl.get(urlKey),
      why: `url 与 ${seenMaterialUrl.get(urlKey)} 重复（同一份材料只入库一次）${diverge.length ? `；两份副本的 ${diverge.join("、")} 不一致 → 按被丢弃副本写的身份键会变成死键` : "；两份副本内容一致，删掉这条即可"}`,
    });
    continue;
  }
  seenMaterialUrl.set(urlKey, `${row.file}#L${row.line}`);
  byUrl.set(urlKey, { title: m.title, bodyText: m.bodyText, theme: row.theme, at: `${row.file}#L${row.line}` });
  const source = SOURCES.get(m.sourceId);
  if (SOURCES.size && !source) {
    materialWarns.push({ ...row, why: `sourceId "${m.sourceId}" 不在 industry/sources.json 里：ingest 会自动建一个 tier=T2、participation_mode=isolated 的隔离源`, what: "material" });
  }
  // 分级以登记表为准：门槛按分级取，运行时用的是数据库 sources.tier（由 sources.json 播种），片段抄的那份会漂。
  const registryTier = source?.tier ?? null;
  if (registryTier && m.sourceTier != null && m.sourceTier !== registryTier) {
    tierDrift.push({ id: `${row.theme}-L${row.line}`, sourceId: m.sourceId, at: `${row.file}#L${row.line}`, from: m.sourceTier, to: registryTier });
  }
  // 未解码的 HTML 实体会原样进正文、进摘要、进读者眼前（16.96&#176;C），也会让按「16.96°C」写的身份键变死键。
  const entities = [...new Set((`${m.title} ${m.bodyText}`).match(/&#[0-9]{1,4};|&(amp|lt|gt|quot|nbsp|#39);/g) ?? [])];
  if (entities.length) {
    materialWarns.push({ ...row, why: `正文/标题里有 ${entities.length} 个未解码 HTML 实体（${entities.slice(0, 4).join(" ")}）→ 会原样出现在读者面前，按字面量写的身份键也会断`, what: "material" });
  }
  materials.push({
    theme: row.theme, file: row.file, line: row.line, raw: row.raw,
    id: typeof m.id === "string" && m.id ? m.id : `${row.theme}-L${row.line}`,
    sourceId: m.sourceId,
    sourceName: source?.name ?? m.sourceId,
    url: m.url.trim(),
    title: m.title.trim(),
    originalTitle: typeof m.originalTitle === "string" ? m.originalTitle.trim() : null,
    bodyText: m.bodyText,
    publishedAt: m.publishedAt,
    pubMs: pub.getTime(),
    timelineAt: m.timelineAt ?? null,
    language: m.language ?? (/[A-Za-z]{4}/.test(m.title) && !/[\u4e00-\u9fff]/.test(m.title) ? "en" : "zh"),
    sourceTier: registryTier ?? m.sourceTier ?? "T2",
    firstParty: m.firstParty === true,
  });
}

/** 材料集：per-capability 的请求文本近似（与 backend 的请求构造逐字段对齐）。 */
function hayFor(cap, m, titleField = "title") {
  // translate 的请求体只有 {"segments":[…]}：片段来自正文，没有标题、没有网址、没有信源名。
  if (cap === "translate_body" || cap === "translate_post") return norm(cpSlice(m.bodyText, MAXBODY));
  const title = norm(m[titleField] ?? "");
  const body = norm(cpSlice(m.bodyText, cap === "structure" ? STRUCT_BODY : MAXBODY));
  if (cap === "scores") return `${norm(m.publishedAt ?? "")}${title}${body}`;
  const url = norm(m.url);
  const src = norm(m.sourceName);
  return `${src}${title}${body}${url}`;
}
const HAY_TITLES = { scores: ["title", "originalTitle"], prefilter: ["title"], understand: ["title"], summarize: ["title"], structure: ["title"], translate_body: ["title"], translate_post: ["title"] };

function matchLine(match, hay) {
  const all = [...list(match.includes), ...list(match.urlIncludes), ...list(match.titleIncludes), ...list(match.textIncludes)].map(norm).filter(Boolean);
  const any = list(match.anyIncludes).map(norm).filter(Boolean);
  const none = list(match.notIncludes).map(norm).filter(Boolean);
  if (!all.every((n) => hay.includes(n))) return false;
  if (any.length && !any.some((n) => hay.includes(n))) return false;
  if (none.some((n) => hay.includes(n))) return false;
  return true;
}

/** 一行 match 在材料集上命中了谁（按 title 与按 originalTitle 两种入库约定各算一次）。 */
function resolveAgainstMaterials(cap, match) {
  const byField = {};
  for (const tf of HAY_TITLES[cap] ?? ["title"]) {
    byField[tf] = materials.filter((m) => matchLine(match, hayFor(cap, m, tf)));
  }
  return byField;
}

/** 两份材料副本的不一致怎么写成人话（折叠后可见的差异单独标出来）。 */
const divergeText = (d) => (d.diverge ?? []).join("、") || "内容一致";

/** 忽略标点的二次判定：只用来解释「为什么这个键是死的」，不作为放行依据。 */
const LOOSE = (s) => norm(s).replace(/[^\p{L}\p{N}]/gu, "");
function looseHits(cap, match) {
  const needles = [...list(match.includes), ...list(match.urlIncludes), ...list(match.titleIncludes), ...list(match.textIncludes)].map(LOOSE).filter(Boolean);
  const any = list(match.anyIncludes).map(LOOSE).filter(Boolean);
  const none = list(match.notIncludes).map(LOOSE).filter(Boolean);
  if (!needles.length && !any.length) return [];
  return materials.filter((m) => {
    const h = LOOSE(hayFor(cap, m, "title")) + "|" + LOOSE(hayFor(cap, m, "originalTitle"));
    return needles.every((n) => h.includes(n)) && (!any.length || any.some((n) => h.includes(n))) && none.every((n) => !h.includes(n));
  });
}

/** 只折叠引号/破折号/nbsp 的判定：这是「运行时真的匹配不上」和「排版形近字符捣乱」的分界线。 */
function matchFolded(match, hay) {
  const all = [...list(match.includes), ...list(match.urlIncludes), ...list(match.titleIncludes), ...list(match.textIncludes)].map(normKey).filter(Boolean);
  const any = list(match.anyIncludes).map(normKey).filter(Boolean);
  const none = list(match.notIncludes).map(normKey).filter(Boolean);
  if (!all.every((n) => hay.includes(n))) return false;
  if (any.length && !any.some((n) => hay.includes(n))) return false;
  if (none.some((n) => hay.includes(n))) return false;
  return true;
}
function foldHits(cap, match) {
  const out = [];
  for (const tf of HAY_TITLES[cap] ?? ["title"]) {
    for (const m of materials) if (matchFolded(match, hayFoldedFor(cap, m, tf))) out.push({ m, tf });
  }
  return out;
}
/** hayFor 的折叠版：结构与运行时请求文本一致，只是每个字段用 normKey（折叠引号/破折号/nbsp）再拼。 */
function hayFoldedFor(cap, m, titleField = "title") {
  if (cap === "translate_body" || cap === "translate_post") return normKey(cpSlice(m.bodyText, MAXBODY));
  const title = normKey(m[titleField] ?? "");
  const body = normKey(cpSlice(m.bodyText, cap === "structure" ? STRUCT_BODY : MAXBODY));
  if (cap === "scores") return `${normKey(m.publishedAt ?? "")}${title}${body}`;
  return `${normKey(m.sourceName)}${title}${body}${normKey(m.url)}`;
}

// ── Per-capability reply validation（返回 problems[]，notes[]）────────────────────────────────
function checkTags(tags, where) {
  const problems = [];
  const notes = [];
  if (!Array.isArray(tags)) return { problems: [`${where}.tags 必须是数组`], notes };
  if (tags.length > 12) problems.push(`${where}.tags ${tags.length} 个 > 12（StructureSchema/UnderstandSchema 上限）`);
  if (!taxonomy.ok || !normalizeTags) { notes.push(`${where}.tags 未校验（taxonomy 现场 import 失败）`); return { problems, notes }; }
  const mapped = tags.map((t) => String(t).trim().replace(/^#/, "")).map((t) => TAX.synonyms[t] ?? TAX.synonyms[t.toLowerCase()] ?? t);
  const kept = normalizeTags(tags, { max: Math.max(tags.length, 1) });
  const dropped = tags.filter((t, i) => !kept.includes(mapped[i]));
  if (dropped.length) problems.push(`${where}.tags 会被 normalizeTags 静默丢弃：${dropped.map((t) => `「${t}」`).join("、")}（词表=13 分类标签+${TAX.topicTags.length} 主题+${TAX.entityTags.length} 实体）`);
  const first = String(tags[0] ?? "");
  if (tags.length && !TAX.categoryTags.includes(mapped[0])) {
    problems.push(`${where} 的第一个标签必须是分类标签，当前是「${first}」→ 会被换成「${kept[0]}」`);
  }
  return { problems, notes };
}

function checkLen(value, max, where, problems, { min = 0 } = {}) {
  if (typeof value !== "string") { problems.push(`${where} 必须是字符串`); return; }
  const n = cps(value);
  if (n > max) problems.push(`${where} ${n} 字 > ${max}（调用方会截断/压缩）`);
  if (n < min) problems.push(`${where} ${n} 字 < ${min}`);
}

const VALIDATORS = {
  prefilter(r) {
    const p = [];
    if (!LABELS.includes(String(r.label))) p.push(`label "${r.label}" 不是 PASS/BLOCK/UNKNOWN`);
    checkLen(r.reason, 200, "reason", p, { min: 1 });
    if (r.reason && SENTENCES(r.reason) > 3) p.push(`reason 句数 ${SENTENCES(r.reason)} 偏多（≤200 字的一句话理由）`);
    return { problems: p, notes: [] };
  },
  scores(r) {
    const p = [];
    const a = r.attentionScore;
    if (!Number.isInteger(a) || a < 0 || a > 100) p.push(`attentionScore ${JSON.stringify(a)} 必须是 0-100 整数`);
    if (r.scoreSecond !== undefined && (!Number.isInteger(r.scoreSecond) || r.scoreSecond < 0 || r.scoreSecond > 100)) p.push(`scoreSecond ${JSON.stringify(r.scoreSecond)} 必须是 0-100 整数`);
    if (r.note !== undefined && typeof r.note !== "string") p.push("note 必须是字符串");
    return { problems: p, notes: [] };
  },
  understand(r) {
    const p = [];
    const n = [];
    if (taxonomy.ok && !TAX.itemTypes.includes(r.itemType)) p.push(`itemType "${r.itemType}" 不在 ITEM_TYPES(${TAX.itemTypes.join("/")})，UnderstandSchema 会整条拒绝`);
    if (!ROLES.includes(String(r.authorRole))) p.push(`authorRole "${r.authorRole}" 不是 principal/observer/relayer`);
    const t = checkTags(r.tags, "understand");
    p.push(...t.problems);
    n.push(...t.notes);
    checkLen(r.editorialJudgment, 400, "editorialJudgment", p, { min: 1 });
    checkLen(r.titleZh, 200, "titleZh", p, { min: 1 });
    checkLen(r.summaryZh, 4000, "summaryZh", p, { min: 1 });
    const sc = cps(r.summaryZh ?? "");
    if (sc > 200) p.push(`summaryZh ${sc} 字 > 200：finalizeCopy 的 answer-first 规则会压缩它（契约要求 190 字内）`);
    else if (sc > 190) n.push(`summaryZh ${sc} 字，超出「190 字内」的写作约定`);
    const sents = SENTENCES(r.summaryZh ?? "");
    if (sents > 3) p.push(`summaryZh ${sents} 句 > 3（契约：2–3 句）`);
    if (sents < 2) n.push(`summaryZh 只有 ${sents} 句（契约建议 2–3 句）`);
    return { problems: p, notes: n };
  },
  summarize(r) {
    const p = [];
    const n = [];
    const keys = Object.keys(r);
    if (!keys.length) p.push("reply 是空对象");
    for (const k of keys) if (!["titleZh", "summaryZh", "bodyZh"].includes(k)) p.push(`summarize 的 reply 只认 titleZh/summaryZh/bodyZh，多出 "${k}"`);
    checkLen(r.titleZh, 200, "titleZh", p, { min: 1 });
    if (r.summaryZh !== undefined) {
      const sc = cps(r.summaryZh);
      if (sc > 200) p.push(`summaryZh ${sc} 字 > 200（finalizeCopy 会压缩）`);
      const sents = SENTENCES(r.summaryZh);
      if (sents > 3) p.push(`summaryZh ${sents} 句 > 3`);
    }
    if (r.bodyZh !== undefined && typeof r.bodyZh !== "string") p.push("bodyZh 必须是字符串");
    if (!r.bodyZh) n.push("bodyZh 为空（只出标题+摘要）");
    return { problems: p, notes: n };
  },
  structure(r) {
    const p = [];
    const n = [];
    if (r.category !== null && taxonomy.ok && !TAX.categories.includes(r.category)) p.push(`category "${r.category}" 不在 CATEGORIES(${TAX.categories.join("/")})，调用方会归 null`);
    const t = checkTags(r.tags, "structure");
    p.push(...t.problems);
    n.push(...t.notes);
    if (!Array.isArray(r.subjects)) p.push("subjects 必须是数组");
    else {
      if (r.subjects.length > 6) p.push(`subjects ${r.subjects.length} 个 > 6`);
      if (taxonomy.ok) {
        const unknown = r.subjects.filter((s) => !TAX.entities.includes(String(s)));
        if (unknown.length) p.push(`subjects 不在 ENTITIES，会被调用方丢掉：${unknown.join("、")}（可用 id：${TAX.entities.join(" ")}）`);
      }
    }
    if (r.fact !== null) {
      if (typeof r.fact !== "object" || !r.fact) p.push("fact 必须是对象或 null");
      else {
        checkLen(r.fact.title, 80, "fact.title", p, { min: 1 });
        if (cps(r.fact.title ?? "") > 30) n.push(`fact.title ${cps(r.fact.title)} 字 > 30（fixture 头部约定；同一事件多篇必须逐字一致，太长容易写分歧）`);
        for (const k of ["subject", "action"]) if (r.fact[k] != null) checkLen(r.fact[k], 80, `fact.${k}`, p);
        if (r.fact.object != null) checkLen(r.fact.object, 160, "fact.object", p);
        if (r.fact.occurredAt != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.fact.occurredAt))) p.push(`fact.occurredAt "${r.fact.occurredAt}" 必须是 YYYY-MM-DD`);
        const extra = Object.keys(r.fact).filter((k) => !["title", "subject", "action", "object", "occurredAt"].includes(k));
        if (extra.length) p.push(`fact 多出字段：${extra.join("、")}`);
      }
    }
    return { problems: p, notes: n };
  },
  group_batch(r) {
    return checkDecisions(r, true);
  },
  group_signal(r) {
    return checkDecisions(r, false);
  },
  group_pair(r) {
    const p = [];
    if (!RELATIONS.includes(String(r.relation))) p.push(`relation "${r.relation}" 不是 ${RELATIONS.join("/")}`);
    const c = Number(r.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) p.push(`confidence ${JSON.stringify(r.confidence)} 必须是 0-1`);
    for (const k of ["a", "b", "difference"]) if (r[k] !== undefined) checkLen(r[k], 400, k, p);
    if (String(r.relation) === "SAME_STORY" && c < 0.75) p.push(`SAME_STORY 的 confidence ${c} < 0.75（relate.ts STORY_REVIEW_MIN_CONFIDENCE 复核不过）`);
    return { problems: p, notes: [] };
  },
  digest(r) {
    const p = [];
    checkLen(r.title, 120, "title", p, { min: 1 });
    checkLen(r.digest, 2000, "digest", p, { min: 10 });
    checkLen(r.latest, 300, "latest", p, { min: 1 });
    return { problems: p, notes: [] };
  },
  report_lead(r) {
    const p = [];
    checkLen(r.title, 120, "title", p, { min: 1 });
    checkLen(r.leadParagraph, 600, "leadParagraph", p, { min: 1 });
    if (!Array.isArray(r.highlights)) p.push("highlights 必须是数组（可空）");
    else {
      if (r.highlights.length > 6) p.push(`highlights ${r.highlights.length} 个 > 6`);
      if (r.highlights.some((h) => !Number.isInteger(h) || h < 1)) p.push("highlights 必须是 1-based 条目编号整数");
    }
    return { problems: p, notes: [] };
  },
  report_period(r) {
    const p = [];
    checkLen(r.headline, 60, "headline", p, { min: 1 });
    checkLen(r.overview, 1500, "overview", p, { min: 1 });
    if (!Array.isArray(r.themes) || r.themes.length < 1) p.push("themes 至少 1 个（调用方 .min(1) 没有兜底）");
    else {
      if (r.themes.length > 6) p.push(`themes ${r.themes.length} 个 > 6（会被截断）`);
      r.themes.forEach((th, i) => {
        checkLen(th?.heading, 60, `themes[${i}].heading`, p, { min: 1 });
        checkLen(th?.summary, 800, `themes[${i}].summary`, p, { min: 1 });
        if (!Array.isArray(th?.refs)) p.push(`themes[${i}].refs 必须是 1-based 编号数组`);
        else if (th.refs.length > 8) p.push(`themes[${i}].refs ${th.refs.length} 个 > 8`);
      });
    }
    return { problems: p, notes: [] };
  },
  translate_body(r) {
    return checkTranslate(r);
  },
  translate_post(r) {
    return checkTranslate(r);
  },
};

function checkDecisions(r, withNote) {
  const p = [];
  const n = [];
  if (r.query !== undefined) checkLen(r.query, 400, "query", p);
  if (!Array.isArray(r.decisions) || !r.decisions.length) p.push("decisions 必须是非空数组");
  else {
    r.decisions.forEach((d, i) => {
      if (!d || typeof d !== "object") { p.push(`decisions[${i}] 必须是对象`); return; }
      const addr = d.candidateIncludes ?? d.id ?? d.includes;
      if (addr == null) p.push(`decisions[${i}] 需要 candidateIncludes 或 id`);
      if (!RELATIONS.includes(String(d.relation))) p.push(`decisions[${i}].relation "${d.relation}" 非法`);
      const c = Number(d.confidence);
      if (d.confidence !== undefined && (!Number.isFinite(c) || c < 0 || c > 1)) p.push(`decisions[${i}].confidence ${JSON.stringify(d.confidence)} 必须是 0-1`);
      if (withNote) { if (d.note !== undefined) checkLen(d.note, 400, `decisions[${i}].note`, p); }
      else if (d.note !== undefined) p.push(`group_signal 的 decisions 没有 note 字段（多余键会被丢掉，写在这里像是笔误）`);
      const extra = Object.keys(d).filter((k) => !["candidateIncludes", "includes", "id", "relation", "confidence", "note"].includes(k));
      if (extra.length) p.push(`decisions[${i}] 多出字段：${extra.join("、")}`);
    });
    const sameStory = r.decisions.filter((d) => String(d?.relation) === "SAME_STORY" && Number(d?.confidence) < 0.8);
    if (sameStory.length) n.push(`SAME_STORY 的 confidence < 0.8：group_signal 只把 ≥0.8 当作对事件的反应（relate.ts signalTarget）`);
  }
  return { problems: p, notes: n };
}

function checkTranslate(r) {
  const p = [];
  const n = [];
  const hasT = Array.isArray(r.t);
  const hasMap = Array.isArray(r.segmentMap);
  if (!hasT && !hasMap) { p.push("需要 t（每个片段一句）或 segmentMap（按片段寻址）"); return { problems: p, notes: n }; }
  if (hasT) {
    if (!r.t.length) p.push("t 是空数组");
    if (r.t.some((x) => typeof x !== "string")) p.push("t 的元素必须是字符串");
    n.push("用 t：请求被二分批次时长度会错位，批量补稿优先 segmentMap");
  }
  if (hasMap) {
    r.segmentMap.forEach((m, i) => {
      if (!m || typeof m !== "object") { p.push(`segmentMap[${i}] 必须是对象`); return; }
      if (!m.includes && !m.segmentIncludes) p.push(`segmentMap[${i}] 需要 includes`);
      if (typeof m.zh !== "string" || !m.zh.trim()) p.push(`segmentMap[${i}].zh 必须是非空译文`);
    });
  }
  return { problems: p, notes: n };
}

// ── Brain line validation ─────────────────────────────────────────────────────────────────────
const accepts = new Map();      // cap -> [{theme, tier, id, raw, obj, order}]
const added = [];
const skipped = [];
const rejected = [];
const warns = [];               // 并入但有集成风险，需要语料 agent 复核
const collisions = [];          // 同一身份键两份人工判断：后一份一行都不生效（= 人工内容被丢）
const noteDrifts = [];          // 同 id、答案完全一致，只有 note/what 这类记账文字不同（门槛重算后的正常漂移）
const notes = [];
const noAuthor = [];

function signature(obj) {
  const m = obj.match ?? {};
  const keys = Object.keys(m).sort().map((k) => `${k}:${JSON.stringify(Array.isArray(m[k]) ? m[k].map(String) : list(m[k]).map(norm))}`);
  return `${obj.capability}|${keys.join("|")}`;
}

/**
 * 一行的「答题内容」= match + reply 去掉 note + 除记账字段以外的全部键。
 * note/what 是人写给同事看的算式与说明，stub 从不返回它，所以两份只差 note 的行不是「两份冲突的人工判断」，
 * 只是同一判断的账目漂移（门槛每重算一次，scores 的 note 就要集体改写一遍）。分开放，冲突账本才只剩
 * 真需要人来定夺的条目。
 */
const BOOKKEEPING = new Set(["note", "what"]);
function answerKey(raw) {
  let o;
  try { o = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  const strip = (v) => (v && typeof v === "object" && !Array.isArray(v))
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !BOOKKEEPING.has(k)))
    : v;
  return JSON.stringify({ match: strip(o.match), reply: strip(o.reply), enabled: o.enabled ?? true, guard: o.guard ?? null, dissent: o.dissent ?? null, pendingMaterial: o.pendingMaterial ?? null });
}

for (const row of brainRows) {
  const o = row.obj;
  const problems = [];
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const cap = typeof o.capability === "string" ? o.capability.trim() : "";
  const label = `${row.file}#L${row.line}`;
  const fail = (why) => rejected.push({ ...row, id: id || "(无 id)", capability: cap || "(无 capability)", why });

  if (!id) problems.push("缺少 id（stub 的 readFixtureFile 会直接判为坏行）");
  if (!cap) problems.push("缺少 capability 字段（片段级文件可以省略，合并后必须能定到某个能力）");
  if (cap && !CAPS.has(cap)) problems.push(`capability "${cap}" 不是 13 个能力之一`);
  if (!o.match || typeof o.match !== "object") problems.push("缺少 match 对象");
  if (!o.reply || typeof o.reply !== "object" || Array.isArray(o.reply)) problems.push("缺少 reply 对象");
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") problems.push("enabled 必须是布尔");
  if (cap && cap !== "summarize" && Object.keys(o.reply ?? {}).length === 0) problems.push("reply 是空对象");
  if (problems.length) { fail(problems.join("；")); continue; }
  if (!o.author) noAuthor.push(`${row.file}#L${row.line} ${id}`);

  const mKeys = Object.keys(o.match);
  const illegalMatch = mKeys.filter((k) => !MATCH_KEYS.has(k));
  if (illegalMatch.length) { fail(`match 里有无效键 ${illegalMatch.join("、")}（stub 只认 ${[...MATCH_KEYS].join("/")}；写错的键等于没写，这行会命中该能力的每一个请求）`); continue; }
  const needles = [...list(o.match.includes), ...list(o.match.urlIncludes), ...list(o.match.titleIncludes), ...list(o.match.textIncludes), ...list(o.match.queryIncludes), ...list(o.match.candidateIncludes), ...list(o.match.anyIncludes), ...list(o.match.notIncludes)];
  if (!needles.length) { fail("match 是空对象：它会命中这个能力的所有请求，第一行命中生效时会吞掉后面所有的稿件"); continue; }

  if (cap === "scores") {
    const urlish = [...list(o.match.urlIncludes), ...list(o.match.includes)].filter((v) => /https?:\/\//i.test(String(v)));
    if (urlish.length) {
      warns.push({ id, capability: cap, theme: row.theme, at: label, why: `${SCORE_NO_URL}；这里把整段网址当身份键（${urlish.join(" / ")}），只有正文恰好粘了同一个网址才会命中` });
    }
    // note 里写下的「门槛 N → sum 与 2N 比大小」必须和 industry/selection.ts 的现值一致：
    // 门槛已经重算过两轮（60/65/76 → 58/59/63 → Wave 4 的 56/59/62），语料里还有一批行按旧值下结论。
    // 分数本身不用改（五轴算式与门槛无关），但「所以入选/不入选」这句结论会假，而 note 是读者能看到的
    // 编辑判断的一部分。同一条断言在合并之后再对 fixture 的最终内容跑一遍（fixtureAudit）——stub 读的是
    // 存量行，片段被跳过时没人会再读它。
    const note = String(o.reply?.note ?? "");
    for (const cited of [...note.matchAll(/门槛\s*(\d{2})/g)].map((x) => Number(x[1]))) {
      if (!Object.values(GATE).includes(cited)) {
        notes.push({ where: `${label} ${id}`, note: `note 里引用的门槛 ${cited} 不是 industry/selection.ts 的现值（${TIERS.slice(0, 3).map((t) => `${t}=${GATE[t]}`).join(" / ")}）→ 这句「入选/不入选」的结论要按现值重算` });
      }
    }
    for (const [tier, cited] of [...note.matchAll(/（(T1_5|T1|T2)）?\s*门槛\s*(\d{2})/g)].map((x) => [x[1], Number(x[2])])) {
      // note 只要把该档的现值也写了出来（整修时追加的「按 industry/selection.ts 现值 T1=56…」复核句），就算交代过。
      if (GATE[tier] != null && GATE[tier] !== cited && !new RegExp(`${tier}\\s*=\\s*${GATE[tier]}`).test(note)) {
        warns.push({ id, capability: cap, theme: row.theme, at: label, why: `note 写「${tier} 门槛 ${cited}」，但 selection.ts 现值是 ${GATE[tier]} → 该条 sum ${(Number(o.reply?.attentionScore) || 0) + (Number(o.reply?.scoreSecond) || 0)} 对 2×${GATE[tier]}=${2 * GATE[tier]}，入选结论要重述` });
      }
    }
  }
  // candidateIncludes 只在有候选块的调用里成立；其他能力的 h.candidates 是空串 → 这一行永远不会命中。
  if (o.match.candidateIncludes != null && !["group_batch", "group_signal"].includes(cap)) {
    fail(`candidateIncludes 对 ${cap} 是死键（非归组调用没有候选块，stub 的 candidates 域是空串，这一行永远不命中）`);
    continue;
  }
  if (o.match.queryIncludes != null && !["group_batch", "group_signal"].includes(cap)) {
    notes.push({ where: `${label} ${id}`, note: `queryIncludes 在 ${cap} 里等价于整条消息（没有独立的【新报道】段），改用 titleIncludes/textIncludes 更清楚` });
  }

  const v = VALIDATORS[cap] ? VALIDATORS[cap](o.reply) : { problems: [`${cap} 没有校验器`], notes: [] };
  if (v.problems.length) { fail(v.problems.join("；")); continue; }

  // 身份键在材料集上必须唯一命中一份材料（MATERIAL_CAPS），否则 first-match-wins 会把稿子发错材料。
  let tierForOrder = null;
  let titleConventionNote = null;
  if (MATERIAL_CAPS.has(cap)) {
    const byField = resolveAgainstMaterials(cap, o.match);
    const fields = Object.keys(byField);
    let chosen = fields.find((f) => byField[f].length >= 1);
    const multi = fields.filter((f) => byField[f].length > 1);
    if (!chosen) {
      // 死键。过去只是 warn，于是「语料 agent 复核」这件事从来没发生（W2-M3）：现在按成因分三级。
      const dupHit = dupCopies.find((d) => matchLine(o.match, hayFor(cap, d, "title")) || (fields.includes("originalTitle") && matchLine(o.match, hayFor(cap, d, "originalTitle"))));
      const folded = foldHits(cap, o.match);
      const loose = looseHits(cap, o.match);
      if (dupHit) {
        fail(`身份键命中 0 份胜出材料，但命中了被丢弃的重复副本 ${dupHit.at}（同一 url 的另一份，${dupHit.diverge?.length ? `其 ${divergeText(dupHit)} 与胜出副本不同` : "副本"}）→ 这条判断挂在一份不会入库的材料上，运行时永远不触发。先定谁是标准件，再把身份键改写到标准件上`);
        continue;
      }
      if (folded.length) {
        const probe = hayFor(cap, folded[0].m, folded[0].tf);
        fail(`身份键在运行时（stub 的 norm 只删空白）命中 0 份材料，但折叠引号/破折号/nbsp 后命中 ${folded.length} 份（${folded.slice(0, 2).map((h) => `${h.m.theme}:${cpSlice(h.m.title, 20)}`).join(" / ")}）：${foldDivergence(String([...list(o.match.includes), ...list(o.match.titleIncludes), ...list(o.match.textIncludes)][0] ?? ""), probe)} 就插在短语中间。运行时不会替你折叠 —— 换成材料里逐字连续的片段（不含任何引号/破折号），或用材料内唯一 ID`);
        continue;
      }
      if (loose.length) {
        fail(`身份键命中 0 份材料，但忽略全部标点后命中 ${loose.slice(0, 2).map((l) => `${l.theme}:${cpSlice(l.title, 20)}`).join(" / ")}：原文在短语中间插了标点，子串断了。换成不含标点的连续片段`);
        continue;
      }
      if (typeof o.pendingMaterial === "string" && o.pendingMaterial.trim()) {
        notes.push({ where: `${label} ${id}`, note: `身份键在已策划材料集上命中 0 份（声明为只拦实采稿件：${o.pendingMaterial}）—— 它不会命中现有任何一稿，材料入库后才会生效` });
      } else {
        warns.push({ id, capability: cap, theme: row.theme, at: label, why: `身份键在合并材料集上命中 0 份材料（按 ${fields.join("/")} 都是空）：这条判断永远不会被触发。要么它对应的材料没进语料（噪声拦截稿常见，可接受，但要在行上写 pendingMaterial 说明），要么身份键写的是入库后不存在的字段` });
      }
    } else if (multi.length) {
      const hits = byField[multi[0]];
      const perSegment = cap === "translate_body" || cap === "translate_post";
      if (perSegment && Array.isArray(o.reply.segmentMap)) {
        warns.push({ id, capability: cap, theme: row.theme, at: label, why: `身份键同时命中 ${hits.length} 份材料（${hits.slice(0, 3).map((h) => `${h.theme}:${cpSlice(h.title, 22)}`).join(" / ")}）；因为用 segmentMap 按片段寻址，跨材料命中不会发错稿，但这条线会成为这些材料的第一个命中，后面的同材料稿件全部被跳过` });
      } else {
        fail(`身份键有歧义：按 ${multi[0]} 同时命中 ${hits.length} 份材料（${hits.slice(0, 3).map((h) => `${h.theme}:${cpSlice(h.title, 24)}`).join(" / ")}）。第一行命中生效 → 这几份材料会拿到同一份稿/${cap === "scores" ? "同一个分数" : "同一份判断"}。改用只在其中一份里出现的片段（材料内唯一 ID，如 CD.2026…）`);
        continue;
      }
    } else {
      tierForOrder = byField[chosen][0].sourceTier ?? null;
    }
    if (chosen && fields.length > 1 && chosen === "originalTitle") {
      titleConventionNote = `${label} ${cap} 行的身份键只在「入库标题=originalTitle（英文原题）」的约定下命中；seed-curated 入库脚本必须把 articles.title 写成原题，否则这行永远不命中`;
    }
    if (!SOURCES.size) { /* registry 缺失就不查，交给材料层的告警 */ }

    // 真实守卫跑一遍（--lint 只对写了 guard 的行做这件事；这里用命中的那份材料补齐 guard，所以每稿都被查）。
    if (finalizeCopy && chosen && (cap === "understand" || cap === "summarize")) {
      const m = byField[chosen][0];
      const src = o.guard ?? { title: m.title, text: m.bodyText, sourceName: m.sourceName, url: m.url, sourceKind: SOURCES.get(m.sourceId)?.kind ?? "rss" };
      const copy = { titleZh: String(o.reply.titleZh ?? ""), summaryZh: String(o.reply.summaryZh ?? "") };
      try {
        const guarded = finalizeCopy({ title: src.title ?? "", text: src.text ?? "", sourceKind: src.sourceKind ?? "rss", sourceName: src.sourceName, documentUrl: src.url }, copy);
        const ig = guarded.identityGuard;
        if (ig?.outcome === "fallback") {
          const why = `身份守卫会整段退回（enforceIdentity）：标题丢 ${ig.unsupportedTitleEntityIds.join("/") || "无"}，摘要丢 ${ig.unsupportedSummaryEntityIds.join("/") || "无"} —— 中文稿写了材料里没出现过的机构称谓，读者会看到空摘要。称谓必须与原文一致（原文写 USGS 就写 USGS）`;
          if (o.guard) { fail(why); continue; }
          warns.push({ id, capability: cap, theme: row.theme, at: label, why: `${why}（这一行没有 guard，比对用的是合并后的材料原文）` });
        } else if (guarded.summaryZh && guarded.summaryZh !== copy.summaryZh) {
          notes.push({ where: `${label} ${id}`, note: `answer-first 规则会把摘要从 ${cps(copy.summaryZh)} 字压到 ${cps(guarded.summaryZh)} 字（真实管道里读者看到的是压缩版）` });
        }
      } catch { /* 守卫加载不了（backend 正在被改）就不拦，交给 --lint */ }
    }
  }

  const key = cap;
  if (!accepts.has(key)) accepts.set(key, []);
  const bucket = accepts.get(key);
  const sig = signature(o);
  bucket.push({ theme: row.theme, tier: tierForOrder, id, raw: row.raw, obj: o, order: bucket.length, label, sig, titleConventionNote });
  v.notes.forEach((n) => notes.push({ where: `${label} ${id}`, note: n }));
  if (titleConventionNote) notes.push({ where: id, note: titleConventionNote });
}

// ── Merge into tooling/fixtures/<cap>.jsonl ───────────────────────────────────────────────────
// 两种模式：
//   默认（追加）  片段只能往 fixture 后面加行；同 id 已存在就跳过并记 collision。片段在被逐个撰写的阶段
//                 这样是对的——不能拿一份可能写歪的片段去覆盖别人已经并进去的判断。
//   --rebuild     fixture = 「tooling 自己写的种子行 + 全部片段接受行」重排而来。语料整修之后必须用它：
//                 我改写了片段里的一行（并桌判断、修死键、补署名），追加模式会让 fixture 里那份旧副本
//                 继续答题，改动一行都落不了地。种子行 = id 不在任何片段里的行，原样保留在最前面。
const mergePlan = [];
const fixtureCounts = {};
/** 片段里出现过的所有 id（含被拒的，用于判断某行是不是「片段的旧副本」而不是 tooling 种子）。 */
const fragmentIds = new Set([...accepts.values()].flat().map((b) => b.id));
/** tooling 自己写的种子行（作者署名以 tooling 开头）——--rebuild 也不动它们。其余行都是片段的派生物。 */
const isSeed = (o) => /^tooling/i.test(String(o?.author ?? ""));
/** fixture 里的 id → 它来自哪个片段的哪一行（tooling 自带示例标 tooling），供 shadow 报告定位。 */
const hitLabels = new Map();
for (const cap of [...CAPS]) {
  const file = path.join(FIXTURES_DIR, `${cap}.jsonl`);
  const read = readJsonl(file);
  const idSet = new Map();
  const sigSet = new Map();
  const seedRaw = [];
  const candidates = (accepts.get(cap) ?? []).slice();
  // 片段里同一 id 的答案副本，用于在 --rebuild 顶掉 fixture 行之前先比对答案（rebuild 是「片段说了算」，
  // 所以答案级差异必须由这里硬拦，否则 Wave 4/5 定稿的判断会被片段的旧副本静默换回去）。
  const fragById = new Map(candidates.map((c) => [c.id, c]));
  for (const d of read.data) {
    const o = d.obj;
    if (!o || typeof o !== "object" || isSeed(o)) { seedRaw.push(d.raw); if (o) hitLabels.set(String(o.id ?? `?L${d.line}`), `tooling/fixtures/${cap}.jsonl#L${d.line}`); continue; }
    if (REBUILD) {
      // 这一行是某个片段的派生物：由片段里的当前版本取代。片段里已经没有这个 id = 整修时把它并进了别行。
      rebuiltDropped.push({ cap, id: String(o.id ?? "?"), at: `tooling/fixtures/${cap}.jsonl#L${d.line}`, why: fragmentIds.has(String(o.id)) ? "由片段里的当前版本取代" : "整修时并入别行（判断已在胜出行的 dissent 里留档），片段里已无此行" });
      const c = fragById.get(String(o.id));
      if (c) {
        const a = answerKey(d.raw), b = answerKey(c.raw);
        if (a !== null && b !== null && a !== b) {
          rejected.push({
            id: String(o.id), capability: cap, theme: c.theme, at: c.label,
            why: `--rebuild 会用 ${c.label} 顶掉 tooling/fixtures/${cap}.jsonl#L${d.line}，但两份的答案（除 note/what）不同 → 已定稿的判断会被片段的旧副本换掉。先把片段同步成现判定，或者不要用 --rebuild`,
          });
        }
      }
      continue;
    }
    const cid = String(o.id ?? `?L${d.line}`);
    seedRaw.push(d.raw);
    idSet.set(cid, d.raw);
    if (!hitLabels.has(cid)) hitLabels.set(cid, `tooling/fixtures/${cap}.jsonl#L${d.line}`);
    sigSet.set(signature({ capability: cap, match: o.match ?? {} }), { raw: d.raw, id: cid, tooling: /^tooling/.test(String(o.author ?? "")) });
  }
  // 确定性顺序：tier（T1 → T1_5 → T2 → 未知）→ 主题 → id
  candidates.sort((a, b) => tierRank(a.tier ?? "ZZ") - tierRank(b.tier ?? "ZZ") || natural(a.theme, b.theme) || natural(a.id, b.id));
  const fresh = [];
  for (const c of candidates) {
    if (idSet.has(c.id)) {
      const same = idSet.get(c.id) === c.raw;
      skipped.push({ id: c.id, capability: cap, theme: c.theme, at: c.label, why: same ? "id 已存在于 tooling/fixtures，且内容一致（跳过）" : "id 已存在但内容不同 —— 未覆盖既有行，需要人工决定谁对（片段可能已被改写）" });
      if (!same) {
        const a = answerKey(idSet.get(c.id));
        const b = answerKey(c.raw);
        if (a !== null && b !== null && a === b) {
          noteDrifts.push({ cap, id: c.id, theme: c.theme, at: c.label, against: `tooling/fixtures/${cap}.jsonl（同 id）`, detail: "match 与 reply（除 note/what）逐字相同，只有 note/what 不同 → 同一判断的账目漂移，不是两份冲突的人工判断；既有行原样保留" });
        } else {
          collisions.push({ cap, id: c.id, theme: c.theme, at: c.label, against: `tooling/fixtures/${cap}.jsonl（同 id）`, kind: "同 id 不同内容", fatal: false, detail: "既有行原样保留，片段这一行整体丢弃（答案级差异：--rebuild 下会硬失败，见上面的 rebuild 守卫）" });
        }
      }
      continue;
    }
    const keySig = signature({ capability: cap, match: c.obj.match ?? {} });
    if (sigSet.has(keySig)) {
      const earlier = sigSet.get(keySig);
      const sameContent = earlier.raw === c.raw;
      skipped.push({ id: c.id, capability: cap, theme: c.theme, at: c.label, why: `match 键与${earlier.tooling ? " tooling 既有示例 " : "已并入的 "}${earlier.id} 完全等价：${sameContent ? "内容也一致，纯重复行" : `两份人工判断内容不同 → 排在先的 ${earlier.id} 生效，这条会被整体吞掉（同一个身份键下只能留一种判断，需要人工合并）`}。${earlier.tooling ? "注意胜出的是 tooling 的未核验示例，它会替这条语料稿答题" : ""}` });
      if (!sameContent) {
        collisions.push({
          cap, id: c.id, theme: c.theme, at: c.label, against: earlier.id,
          kind: earlier.tooling ? "身份键等价，胜出的是 tooling 未核验示例" : "身份键等价，两份人工判断不同",
          fatal: true,
          detail: `first-match-wins → ${earlier.id} 答题，${c.id} 的人工判断一行都不生效`,
        });
      }
      continue;
    }
    const dupInRun = fresh.find((f) => signature(f.obj) === keySig);
    if (dupInRun) { skipped.push({ id: c.id, capability: cap, theme: c.theme, at: c.label, why: `与本次并入的 ${dupInRun.id} match 键等价（重复策划同一份材料）` }); continue; }
    fresh.push(c);
    idSet.set(c.id, c.raw);
    if (!hitLabels.has(c.id)) hitLabels.set(c.id, c.label);
    sigSet.set(keySig, { raw: c.raw, id: c.id, tooling: false });
    added.push({ id: c.id, capability: cap, theme: c.theme, tier: c.tier ?? "-", at: c.label });
  }
  const comments = read.comments.map((c) => c.text);
  const keptRaw = seedRaw;
  const appendedRaw = fresh.map((c) => canonical(c.obj));
  const out = [...comments, ...keptRaw, ...appendedRaw];
  fixtureCounts[cap] = { before: keptRaw.length, added: fresh.length, after: keptRaw.length + fresh.length };
  mergePlan.push({ cap, file, existed: read.data.length + read.comments.length > 0, out });
  read.parseErrors.forEach((e) => rejected.push({ file: path.basename(file), line: e.line, id: "(既有行)", capability: cap, theme: "tooling", why: `tooling/fixtures 里既有的一行读不动：${e.error}` }));
}

/** 稳定的单行序列化：保留作者的键序，只保证没有裸换行。 */
function canonical(obj) {
  return JSON.stringify(obj).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ── 事件文本键：group_*/digest/report_* 对准的是合成文本，只能比对「已策划出来的事实标题与中文标题」。
const eventText = (() => {
  const parts = [];
  for (const { cap, out } of mergePlan) {
    if (cap !== "structure" && cap !== "understand") continue;
    for (const line of out) {
      if (line.startsWith("//")) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const f = o.reply?.fact;
      if (f?.title) parts.push(f.title);
      if (o.reply?.titleZh) parts.push(o.reply.titleZh);
    }
  }
  for (const m of materials) parts.push(m.title, m.originalTitle ?? "");
  return norm(parts.join("\n"));
})();
for (const bucket of [...accepts.values()].flat()) {
  if (MATERIAL_CAPS.has(bucket.obj.capability)) continue;
  const keys = Object.keys(bucket.obj.match);
  if (!keys.some((k) => ["queryIncludes", "candidateIncludes"].includes(k)) && !keys.length) continue;
  const needles = [...list(bucket.obj.match.includes), ...list(bucket.obj.match.titleIncludes), ...list(bucket.obj.match.textIncludes), ...list(bucket.obj.match.queryIncludes), ...list(bucket.obj.match.candidateIncludes), ...list(bucket.obj.match.anyIncludes)].map(norm).filter(Boolean);
  const dead = needles.filter((n) => !eventText.includes(n));
  if (needles.length && dead.length === needles.length) {
    notes.push({ where: `${bucket.label} ${bucket.id}`, note: `事件文本键在「已策划的事实标题/中文标题/材料标题」里一个都找不到：${dead.slice(0, 2).join("、")} —— 归组与综述跑在这批稿件之上，键对不上就永远不会触发（材料级歧义判定对它不适用，所以只提示不拒）` });
  }
}


// ── 日报/周报候选表：照 compose.ts 的渲染原样复算一遍，判定 report_lead / report_period 的键能不能触发。
// 依据（都是运行时代码，不是这里的推测）：
//   · writeLead        : `packages/backend/src/reports/compose.ts:109`  entries.slice(0,30)
//                        → `${i+1}. ${title}｜${summary.slice(0,120)}`，没有分节前缀。
//   · periodPrompt     : `:195` → `本期：${startDate} 至 ${endDateInclusive}\n` +
//                        `${i+1}. [${SECTION_OF[category] ?? DEFAULT}] ${title}｜${summary.slice(0,140)}`。
//   · 候选标题 title    : `publication/publish.ts:177` pickString(f.title, zhTitle ?? article.title)
//                        → 有 fact 的条目在日报里显示的是 structure.fact.title，不是 understand.titleZh。
//   · 8 条/节上限       : `:150` 每节只留 8 条，溢出进 flashes（不进日报正文，也就不在 lead 列表里）。
const LEAD_SEP = "｜";
function reportCandidates() {
  // 每份材料的「最终 fixture 会给出的答案」：分数、是否入选、日报里会显示的那一行。
  const linesOf = (cap) => {
    const plan = mergePlan.find((p) => p.cap === cap);
    if (!plan) return [];
    return plan.out.filter((l) => l.trim() && !l.startsWith("//")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const hitOf = (cap, m) => {
    for (const l of linesOf(cap)) {
      if (!l.match) continue;
      for (const tf of HAY_TITLES[cap] ?? ["title"]) if (matchLine(l.match ?? {}, hayFor(cap, m, tf))) return l;
    }
    return null;
  };
  // 门槛不在这里留任何一份副本：import 失败就是「未校验」，绝不用旧表（60/65/76、58/59/63 都曾经是「现值」）
  // 去冒充 selection.ts，否则这一节的入选数会与运行时不一致，而报告读起来像是核对过。
  const THRESH = { T1: GATE.T1, T1_5: GATE.T1_5, T2: GATE.T2 };
  const out = [];
  for (const m of materials) {
    const s = hitOf("scores", m);
    const u = hitOf("understand", m);
    const st = hitOf("structure", m);
    const sum = s ? Number(s.reply?.attentionScore ?? 0) + Number(s.reply?.scoreSecond ?? s.reply?.attentionScore ?? 0) : null;
    const gate = 2 * (THRESH[m.sourceTier] ?? THRESH.T2);
    // 预筛 BLOCK 的材料在 analyze.ts:343 就停了：不打分、不成稿、不进任何公开出口（rules.ts:25 要 relevance=pass）。
    // 所以候选表必须先问预筛那一行，否则报告会拿一份读者永远看不到的稿子去排日报位次。
    const pf = hitOf("prefilter", m);
    const blocked = pf?.reply?.label === "BLOCK";
    const unrated = !Number.isFinite(gate) || gate <= 0;
    const factTitle = st?.reply?.fact?.title ?? null;
    out.push({
      material: m, scoreLineId: s?.id ?? null, sum, blocked, prefilterLineId: pf?.id ?? null,
      selected: s ? (!blocked && !unrated && sum >= gate) : false,
      // 日报列表里的那一行：fact.title 优先，其次中文标题，最后材料标题（publish.ts:177 的取值顺序）
      title: factTitle || u?.reply?.titleZh || m.title,
      summary: u?.reply?.summaryZh ?? "",
      section: TAX.sectionOf?.[st?.reply?.category ?? ""] ?? TAX.defaultSection ?? "",
    });
  }
  return out;
}
const reportEntries = reportCandidates();
/** 把某份候选表按 writeLead / periodPrompt 的格式渲染成文本（同一套 norm 做子串判定）。 */
function renderLead(entries) {
  return norm(entries.slice(0, 30).map((e, i) => `${i + 1}. ${e.title}${LEAD_SEP}${cpSlice(e.summary, 120)}`).join("\n"));
}
function renderPeriod(entries, startDate, endDateInclusive) {
  return norm(`本期：${startDate} 至 ${endDateInclusive}\n` + entries.map((e, i) => `${i + 1}. [${e.section}] ${e.title}${LEAD_SEP}${cpSlice(e.summary, 140)}`).join("\n"));
}
/** 真实成刊顺序：每节 ≤8（分数降序）→ 展平后按分数降序；并列分数的行序 SQL 不保证，所以两种都试。 */
function leadOrder(pool) {
  const sorted = [...pool].sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0) || natural(a.title, b.title));
  const per = new Map();
  for (const e of sorted) {
    const list = per.get(e.section) ?? [];
    if (list.length < 8) list.push(e);
    per.set(e.section, list);
  }
  return [...per.values()].flat().sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0));
}
const bjDate = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const pool = reportEntries.filter((e) => e.selected);
// 一期一份：日报按北京日期窗口（compose 用 timeline_at，入库后与 publishedAt 同序），周报按 ISO 周，月报按自然月。
const editions = [];
const byDay = new Map();
for (const e of pool) {
  const d = bjDate(e.material.pubMs);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(e);
}
for (const [d, list] of [...byDay].sort()) editions.push({ label: `日报 ${d}`, kind: "lead", text: renderLead(leadOrder(list)), entries: leadOrder(list) });
const isoWeek = (ms) => {
  const t = new Date(ms + 8 * 3600_000);
  const day = (t.getUTCDay() + 6) % 7;
  const thu = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - day + 3));
  const w1 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  return `${thu.getUTCFullYear()}-W${String(1 + Math.round((thu - w1) / 7 / 86400000)).padStart(2, "0")}`;
};
const monthOf = (ms) => bjDate(ms).slice(0, 7);
for (const isWeek of [true, false]) {
  const groups = new Map();
  for (const e of pool) {
    const k = isWeek ? isoWeek(e.material.pubMs) : monthOf(e.material.pubMs);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const [k, list] of [...groups].sort()) {
    const sorted = [...list].sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0) || natural(a.title, b.title)).slice(0, isWeek ? 40 : 60);
    // 区间按 ISO 周 / 自然月算（compose 的 isoWeekRange 与 composeMonthly），不是数据里的 min/max：
    // periodPrompt 把「本期：X 至 Y」原样写进请求，这是报告键里唯一与分数无关、可以逐字钉死的一段。
    const anyMs = Math.min(...list.map((e) => e.material.pubMs));
    const d0 = new Date(anyMs + 8 * 3600_000);
    const mon = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7)));
    const sun = new Date(mon.getTime() + 6 * 86400_000);
    const start2 = isWeek ? mon.toISOString().slice(0, 10) : `${k}-01`;
    const end2 = isWeek ? sun.toISOString().slice(0, 10) : new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0)).toISOString().slice(0, 10);
    editions.push({ label: (isWeek ? "周报 " : "月报 ") + k, kind: "period", text: renderPeriod(sorted, start2, end2), entries: sorted, start: start2, end: end2 });
  }
}
const allEditionsText = () => norm(editions.map((e) => e.text).join("\n"));
const leadOrdered = leadOrder(pool).slice(0, 30);
const leadText = renderLead(leadOrdered);
// 「所有入选材料一次到达」那一期：批量入库（seed-curated 重锚时间线）真的会产生这样一份候选表，
// corpus-report-brain 里那两条「批量入库窗口」的日报键就是照它写的，所以它也进 editions 供 --dump-editions 查。
editions.unshift({ label: "全量批次（一次到达的精选池）", kind: "lead", text: leadText, entries: leadOrdered });
const selectedOrdered = [...pool].sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0)).slice(0, 60);
const periodWeek = renderPeriod(selectedOrdered, "2026-09-28", "2026-10-04");
const periodMonth = renderPeriod(selectedOrdered, "2026-09-01", "2026-09-30");
const reportKeyChecks = [];
for (const bucket of [...accepts.values()].flat()) {
  const cap = bucket.obj.capability;
  if (cap !== "report_lead" && cap !== "report_period") continue;
  if (bucket.obj.enabled === false) { notes.push({ where: `${bucket.label} ${bucket.id}`, note: "整行停用（enabled:false）：它的人工稿是按一份复现不出来的候选表写的，在值主编照本期真实候选表重写之前不答题，但稿子留在语料里可查" }); continue; }
  const needles = [...list(bucket.obj.match.includes), ...list(bucket.obj.match.textIncludes), ...list(bucket.obj.match.anyIncludes)].map(norm).filter(Boolean);
  if (!needles.length) continue;
  const alive = (n) => leadText.includes(n) || periodWeek.includes(n) || periodMonth.includes(n) || allEditionsText().includes(n);
  const dead = needles.filter((n) => !alive(n));
  if (!dead.length) continue;
  const verdicts = dead.map((n) => {
    const bare = n.replace(/^\d+\./, "").replace(/^\[[^\]]*\]/, "");
    if (/^本期/.test(n)) return { kind: "dead", why: `刊期行「${cpSlice(n, 26)}」不是 compose 由 ISO 周/自然月算出来的那一个（周月报的区间分隔是一个空格：本期：X 至 Y）` };
    const exists = pool.some((e) => norm(`${e.title}${LEAD_SEP}${cpSlice(e.summary, 140)}`).startsWith(bare) || norm(e.title) === bare || bare.startsWith(norm(e.title)));
    return exists
      ? { kind: "rank", why: `「${cpSlice(n, 30)}」这条候选存在且会被渲染，但没有任何一个已策划的日/周/月窗口把它排在第 ${n.match(/^(\d+)/)?.[1] ?? "?"} 位` }
      : { kind: "dead", why: `钉的条目在已策划语料里根本渲染不出来：「${cpSlice(n, 30)}」——日报列表里的标题取 structure.fact.title（没有 fact 才是 understand.titleZh），不是材料标题` };
  });
  reportKeyChecks.push({
    id: bucket.id, capability: cap, theme: bucket.theme, at: bucket.label,
    dead: verdicts.filter((v) => v.kind === "dead").length, ranked: verdicts.filter((v) => v.kind === "rank").length, total: needles.length,
    diagnosis: verdicts.map((v) => v.why),
  });
  if (verdicts.every((v) => v.kind === "rank")) {
    // 只是并列分数的排位差：这条键仍可能在别的日/周窗口触发，记一笔不判失败。
    reportKeyChecks.pop();
    notes.push({ where: `${bucket.label} ${bucket.id}`, note: `报告键钉的条目都存在，但没有一期把它们排在这些位次上（并列分数的行序由 SQL 决定）：${verdicts.map((v) => v.why).join("；")}` });
  }
}

// ── 谁会被谁抢掉（first-match-wins 的真实后果）───────────────────────────────────────────────
// 这里不只是列个名字：两行命中同一份材料时，必须说清「后一行的判断是不是和赢的那行不一样」。
// 一样 = 无害重复；不一样 = 一份人工撰写的答案被静默吞掉，那是数据丢失，不是噪音。
const shadows = [];
for (const { cap, out } of mergePlan) {
  if (!MATERIAL_CAPS.has(cap)) continue;
  const lines = out.filter((l) => !l.startsWith("//") && l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((l) => l.enabled !== false);
  if (!lines.length) continue;
  // 两种入库标题约定都要扫（2026-10-01 改）：以前按「整份文件挑一种」——能命中材料的那种（title = 片段里的
  // 中文显示标题，originalTitle = 英文原题）。这会让「两行都只按英文原题命中同一份材料」这一类吞行完全看不见：
  // 实测 score-b2 与 score-fill-eos-kaligandaki-landslide 就是这样，而 scores 的行本来就大多按原题钉的。
  // 逐约定各扫一遍不会造出假吞行：一行只按 title 命中、另一行只按原题命中时，每个约定下都只有一行命中，
  // 那种情况本来就由 titleConventionNote 单独点名（入库约定只会选一种，另一行是死的）。
  const reported = new Set();
  for (const field of ["title", "originalTitle"]) {
    for (const m of materials) {
      const hay = hayFor(cap, m, field);
      const hitters = lines.filter((l) => matchLine(l.match ?? {}, hay));
      if (hitters.length < 2) continue;
      const sig = `${cap}|${m.url}|${[...hitters].sort((a, b) => natural(a.id, b.id)).map((l) => l.id).join(",")}`;
      if (reported.has(sig)) continue;
      reported.add(sig);
      const [win, ...rest] = hitters;
      const sameAs = (l) => JSON.stringify(l.reply ?? null) === JSON.stringify(win.reply ?? null);
      const distinct = rest.filter((l) => !sameAs(l));
      shadows.push({
        cap,
        convention: field,
        material: `${m.theme}:${cpSlice(m[field] ?? m.title, 26)}`,
        materialUrl: m.url,
        winner: win.id,
        winnerAt: lines.indexOf(win) >= 0 ? (hitLabels.get(win.id) ?? null) : null,
        losers: rest.map((l) => l.id),
        loserAt: rest.map((l) => hitLabels.get(l.id) ?? null),
        // 只有「答案文本不同」的吞行才是丢失人工内容；纯重复行留着也只是占位。
        diverges: distinct.length > 0,
        detail: distinct.length
          ? `被吞的 ${distinct.map((l) => l.id).join("、")} 与生效行的 reply 不同 → 这些人工判断一条都不会生效`
          : `被吞的行与生效行 reply 完全相同（无害重复）`,
      });
    }
  }
}

// ── curated-materials.jsonl ───────────────────────────────────────────────────────────────────
const STALE_MS = 48 * 3600 * 1000;
/**
 * auto 模式允许的最大 discoveredAt−publishedAt 间隔。闸门是 48h（materials.ts STALE_ON_DISCOVERY_MS），
 * 但下游 scripts/seed-curated.ts 只接受 gap ≤ 48h−1h（它的 LEAD_MS 余量）并按自己的 anchor 重钉时间，
 * 所以这里留到 46h，保证发出去的每一对时间戳都被它原样采纳，不会退回「按到达时间」。
 */
const AUTO_MAX_GAP_MS = 46 * 3600 * 1000;
function resolveDiscoveredAt(m, now) {
  if (DISCOVERED_AT === "auto") {
    const floor = now - 2 * 3600 * 1000;
    if (m.pubMs <= floor && floor - m.pubMs <= AUTO_MAX_GAP_MS) return new Date(floor);
    return new Date(m.pubMs + 2 * 3600 * 1000);
  }
  const spec = DISCOVERED_AT;
  if (spec === "now") return new Date(now);
  const rel = /^now(?:([+-])(\d+)([hmd]))?$/.exec(spec);
  if (rel) {
    const unit = { h: 3600_000, m: 60_000, d: 86_400_000 }[rel[3] ?? "h"];
    const delta = Number(rel[2] ?? 0) * unit * (rel[1] === "-" ? -1 : 1);
    return new Date(now + delta);
  }
  const d = new Date(spec);
  if (!Number.isFinite(d.getTime())) throw new Error(`--discovered-at 看不懂：${spec}（用 auto|now|now-2h|ISO）`);
  return d;
}

const NOW = Date.now();
const ingested = [];
const windowStats = { now2h: 0, pinned: 0 };
for (const m of materials) {
  const disc = resolveDiscoveredAt(m, NOW);
  const lag = disc.getTime() - m.pubMs;
  if (lag > STALE_MS) windowStats.pinned++; else if (Math.abs(disc.getTime() - (NOW - 7200_000)) < 1000) windowStats.now2h++; else windowStats.pinned++;
  ingested.push({
    kind: "item",
    id: m.id,
    sourceId: m.sourceId,
    sourceName: m.sourceName,
    sourceTier: m.sourceTier,
    firstParty: m.firstParty,
    url: m.url,
    title: m.title,
    originalTitle: m.originalTitle,
    language: m.language,
    publishedAt: new Date(m.pubMs).toISOString(),
    discoveredAt: disc.toISOString(),
    timelineAt: m.timelineAt,
    bodyText: m.bodyText,
    author: null,
    raw: { geohot: { theme: m.theme, fragment: `${m.file}#L${m.line}`, sourceTier: m.sourceTier, firstParty: m.firstParty, discoveredAtMode: DISCOVERED_AT, staleGapHours: Math.round((lag / 3600_000) * 10) / 10 }, _aihot: {} },
  });
}
ingested.sort((a, b) => natural(a.sourceId, b.sourceId) || natural(a.publishedAt, b.publishedAt) || natural(a.url, b.url));

// ── Write ─────────────────────────────────────────────────────────────────────────────────────
const written = [];
if (DO_MERGE && !DRY) {
  for (const plan of mergePlan) {
    if (!plan.existed && !plan.out.length) continue;
    const body = `${plan.out.join("\n")}\n`;
    if (!existsSync(plan.file) || readFileSync(plan.file, "utf8") !== body) {
      writeFileSync(plan.file, body, "utf8");
      written.push(plan.file);
    }
  }
}
if (DO_MATERIALS && !DRY) {
  const body = ingested.map((x) => JSON.stringify(x)).join("\n") + (ingested.length ? "\n" : "");
  writeFileSync(OUT_FILE, body, "utf8");
  written.push(OUT_FILE);
}

if (noAuthor.length) notes.push({ where: `${noAuthor.length} 行`, note: `没有 author 署名（stub 的 --lint 只把它记成 note，不拦），合并后无法回溯这段判断是谁写的：${noAuthor.slice(0, 6).join("、")}${noAuthor.length > 6 ? " …" : ""}` });

/** 一整期的完整编号表：re-pin report_lead / report_period 的键时照它抄，不要照别的清单抄。 */
const DUMP = opt("dump-editions");
if (DUMP) {
  const want = editions.filter((e) => e.label.includes(DUMP) || DUMP === "all");
  if (!want.length) console.log(`没有匹配的期：${DUMP}（可选：${editions.map((e) => e.label).join(" / ")}）`);
  for (const ed of want) {
    console.log(`\n### ${ed.label}${ed.start ? `（${ed.start} 至 ${ed.end}）` : ""} —— ${ed.entries.length} 条`);
    console.log(ed.entries.map((e, i) => `${i + 1}. ${ed.kind === "period" ? `[${e.section}] ` : ""}${e.title}${LEAD_SEP}${cpSlice(e.summary, ed.kind === "period" ? 140 : 120)}`).join("\n"));
  }
  process.exit(0);
}

// ── 冲突账本：默认拦「人工判断被吞掉」，--strict 再拦「值得复核但内容没丢」，两者都写进 merge-conflicts.md ──
// 为什么吞判断默认就拦：warned/shadowed/collision 三类在旧版本里都只打印一行就继续写盘，于是
// 「first-match-wins 把一份人工判断整条吞掉」这件事从来没有人在拦（W2-M3 的成因）。
// 为什么同 id 的片段↔fixture 漂移只算告警：那种行 fixture 里已有一份同样 id 的判断在答题，内容没丢，
// 需要的是有人把片段同步成现判定（或 --rebuild）；实测这类名单动辄几十行，留着当失败就会把被吞的判断盖掉。
const strictHits = [
  ...(STRICT_SHADOWS ? [
    ...shadows.filter((s) => s.diverges).map((s) => ({ kind: "shadowed", id: s.losers.join("、"), capability: s.cap, at: s.winnerAt, why: `${s.material}（${s.convention} 约定）：生效 ${s.winner}，${s.detail}` })),
    ...collisions.filter((c) => c.fatal).map((c) => ({ kind: "collision-swallowed", id: c.id, capability: c.cap, at: c.at, why: `${c.kind}（对 ${c.against}）：${c.detail}` })),
  ] : []),
  ...STRICT ? warns.map((w) => ({ kind: "warned", id: w.id, capability: w.capability, at: w.at, why: w.why })) : [],
  ...STRICT ? collisions.filter((c) => !c.fatal).map((c) => ({ kind: "collision-drift", id: c.id, capability: c.cap, at: c.at, why: `${c.kind}（对 ${c.against}）：${c.detail}` })) : [],
  ...STRICT ? reportKeyChecks.map((r) => ({ kind: "report-key", id: r.id, capability: r.capability, at: r.at, why: `${r.dead}/${r.total} 个身份针在复算的候选表里渲染不出来：${r.diagnosis[0]}` })) : [],
  ...STRICT && noAuthor.length ? [{ kind: "no-author", id: `${noAuthor.length} 行`, capability: "-", at: noAuthor.slice(0, 3).join("、"), why: "缺 author：/__brain/log 里这一段判断无法回溯到是谁写的" }] : [],
  ...STRICT ? materialWarns.filter((w) => /HTML 实体/.test(w.why)).map((w) => ({ kind: "material", id: w.obj.sourceId, capability: "material", at: `${w.file}#L${w.line}`, why: w.why })) : [],
];

/** tooling/corpus/merge-conflicts.md —— 机器可读（表格 + 每节固定列名），也是这次语料整修的账本。 */
function conflictReport() {
  const now = new Date().toISOString();
  const L = [];
  L.push(`<!-- 由 tooling/merge-corpus.mjs 生成；不要手改。模式=${DRY ? "dry-run" : "apply"}${STRICT ? " + --strict" : ""}｜${now} -->`);
  L.push(`# merge-corpus 冲突账本`);
  L.push(``);
  L.push(`片段目录 ${CORPUS_DIR} ｜ fixture ${FIXTURES_DIR} ｜ 材料输出 ${DO_MATERIALS ? OUT_FILE : "(skipped)"}`);
  L.push(`计数：rejected=${rejected.length} materialRejected=${materialRejects.length} warned=${warns.length} ` +
    `shadows=${shadows.length} collisions=${collisions.length} noteDrift=${noteDrifts.length} reportKeysDead=${reportKeyChecks.length} noAuthor=${noAuthor.length} ` +
    `added=${added.length} skipped=${skipped.length} materials=${materials.length}`);
  L.push(`退出码：默认已经把「吞掉不同判断」的行算失败（shadowed 且 reply 不同 + 身份键等价的两份不同判断，本次 ${strictHits.filter((h) => h.kind === "shadowed" || h.kind === "collision-swallowed").length} 条；--no-strict-shadows 可降级）；--strict 再把 warned / 同 id 的答案漂移 / 死键告警 / 报告死针 / 缺 author / 未解码实体一并算失败（本次 strict 命中 ${strictHits.length}）`);
  const table = (title, cols, rows, cell) => {
    L.push(``);
    L.push(`## ${title}（${rows.length}）`);
    if (!rows.length) { L.push(``); L.push(`无`); return; }
    L.push(``);
    L.push(`| ${cols.join(" | ")} |`);
    L.push(`|${cols.map(() => "---").join("|")}|`);
    for (const r of rows) L.push(`| ${cell(r).map((c) => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
  };
  table("一、同 URL 多份材料副本（身份键死因）", ["url", "胜出", "被丢弃", "不一致字段", "处理"], dupCopies,
    (d) => [d.url, d.keptBy, d.at, divergeText(d), "由策划定标准件后删掉一条"]);
  table("二、同 id 的片段↔fixture 答案漂移（告警：fixture 那份继续答题，内容没丢）", ["capability", "id", "位置", "对谁", "成因"], collisions.filter((c) => !c.fatal),
    (c) => [c.cap, c.id, c.at, c.against, c.kind]);
  table("二·a、身份键等价的两份不同人工判断（默认就失败：后一条一行都不生效）", ["capability", "被吞的 id", "位置", "对谁", "成因"], collisions.filter((c) => c.fatal),
    (c) => [c.cap, c.id, c.at, c.against, c.kind]);
  table(`二·b、--rebuild 下被片段当前版本取代的 fixture 旧副本（${rebuiltDropped.length}）`, ["capability", "id", "位置", "处理"], rebuiltDropped,
    (d) => [d.cap, d.id, d.at, d.why]);
  table("二·c、同 id 只有 note/what 不同（同一判断的账目漂移，不冲突）", ["capability", "id", "片段位置", "对谁"], noteDrifts,
    (d) => [d.cap, d.id, d.at, d.against]);
  table("三、first-match-wins 吞行（默认就失败：同一材料被多行命中，只有第一行生效）", ["capability", "标题约定", "材料", "生效", "被吞", "被吞行是否含不同判断"], shadows,
    (s) => [s.cap, s.convention, s.material, `${s.winner} @ ${s.winnerAt ?? "?"}`, s.losers.map((id, i) => `${id} @ ${s.loserAt[i] ?? "?"}`).join("<br>"), s.detail]);
  table("四、身份键命中 0 份材料", ["capability", "id", "位置", "成因"], warns.filter((w) => /命中 0 份/.test(w.why)),
    (w) => [w.capability, w.id, w.at, cpSlice(w.why, 160)]);
  table("五、日报/周报 fixture 的键在真实渲染下能不能触发", ["capability", "id", "位置", "死针/总针", "判定"], reportKeyChecks,
    (r) => [r.capability, r.id, r.at, `${r.dead}/${r.total}`, r.diagnosis.join("<br>")]);
  table("六、缺 author 的行（审计日志无出处）", ["位置"], noAuthor, (x) => [x]);
  table("七、材料层告警", ["片段行", "问题"], materialWarns, (w) => [`${w.file}#L${w.line}`, cpSlice(w.why, 140)]);
  L.push(``);
  L.push(`## 八、候选表复算（compose.ts 的渲染，用来对照第五节）`);
  L.push(``);
  L.push(`入选判据 sum ≥ 2×门槛（SELECTION.thresholds 现场取：T1=${GATE.T1} / T1_5=${GATE.T1_5} / T2=${GATE.T2}）；分级现场取 industry/sources.json 的 tier（运行时的 sources.tier 就是它播种的）。`);
  L.push(`预筛 BLOCK 的 ${reportEntries.filter((e) => e.blocked).length} 份材料不打分、不成稿、不进任何公开出口（analyze.ts:343 + rules.ts:25），所以不在下面的候选表里。`);
  L.push(`日报正文每节 ≤8 条（compose.ts:150），溢出进 flashes 不上正刊；列表标题取 structure.fact.title，`);
  L.push(`没有 fact 才退回 understand.titleZh（publish.ts:177）。摘要在列表里被截到 120（日报）/140（周月报）字。`);
  L.push(``);
  L.push("```text");
  L.push(leadOrdered.slice(0, 30).map((e, i) => `${i + 1}. ${e.title}${LEAD_SEP}${cpSlice(e.summary, 120)}`).join("\n"));
  L.push("```");
  L.push(``);
  L.push(`把每一期单独复算：${editions.length} 期（日报按北京日期、周报按 ISO 周、月报按自然月）。`);
  L.push(`入选 ${reportEntries.filter((e) => e.selected).length} / ${reportEntries.length} 份材料；全量批次受「每节 ≤8」上限约束时进日报正文的是 ${leadOrdered.length} 条，`);
  L.push(`所以日报列表里编号 ${leadOrdered.length + 1} 及以后的位置在任何一天都渲染不出来。周报/月报没有分节上限（取前 ${"40"}/60 条），编号可到 ${Math.min(selectedOrdered.length, 60)}。`);
  L.push(``);
  L.push(`周报（periodPrompt 的渲染，2026-09-28 至 2026-10-04）与月报（2026-09-01 至 2026-09-30）取同一批候选，编号一致：`);
  L.push(``);
  L.push("```text");
  L.push(selectedOrdered.slice(0, 40).map((e, i) => `${i + 1}. [${e.section}] ${e.title}${LEAD_SEP}${cpSlice(e.summary, 140)}`).join("\n"));
  L.push("```");
  L.push(``);
  L.push(`每一期自己的候选表（re-pin 报告键照着这个抄；日报编号从 1 起，周月报带 [节] 前缀）：`);
  L.push(``);
  for (const ed of editions) {
    if (!ed.entries.length) continue;
    L.push(`- **${ed.label}${ed.start ? `（${ed.start} 至 ${ed.end}）` : ""}** —— ${ed.entries.length} 条：`);
    L.push(ed.entries.slice(0, 8).map((e, i) => `${i + 1}. ${ed.kind === "period" ? `[${e.section}] ` : ""}${cpSlice(e.title, 26)}`).join("<br>"));
  }
  L.push(``);
  return `${L.join("\n")}\n`;
}
if (!DRY && DO_MERGE) {
  const body = conflictReport();
  if (!existsSync(CONFLICTS_FILE) || readFileSync(CONFLICTS_FILE, "utf8") !== body) {
    writeFileSync(CONFLICTS_FILE, body, "utf8");
    written.push(CONFLICTS_FILE);
  }
}

// ── fixture 自查（跑最终内容，不只是片段）───────────────────────────────────────────────────
// stub 读的是 tooling/fixtures/*.jsonl，片段被「同 id 已存在 → 跳过」拦掉之后就没人再读它了；门槛重算、
// 提示词改写之后，漂的是存量行。所以这三条断言必须在合并之后对最终内容再跑一遍：
//   1. 每行（含 dissent 内层）都有 author —— 站点的说法是「机器跑管道、人写判断」，/__brain/log 里
//      没有 author 的那一条就没有出处；
//   2. scores 的 note 里引用的门槛必须是 industry/selection.ts 的现值（片段侧已经查过一遍，这里查存量行）；
//   3. scores 的 note 里写的五轴必须按 industry/prompts/selection-score.md 的权重行算得出 attentionScore
//      —— 五轴是判断，分数是算术结果；两边不一致就是有人在门槛变化时改过数字而不是改判断。
const WEIGHT_ROWS = (() => {
  try {
    const md = readFileSync(path.join(REPO, "industry/prompts/selection-score.md"), "utf8");
    const rows = {};
    for (const m of md.matchAll(/^\|\s*([a-z_]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/gm)) {
      const w = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
      if (w.reduce((a, b) => a + b, 0) === 10) rows[m[1]] = w;
    }
    return rows;
  } catch { return {}; }
})();
const AX_LABEL = /sig\s*(\d+)[^+\n]{0,14}\+\s*nov\s*(\d+)[^+\n]{0,14}\+\s*cred\s*(\d+)[^+\n]{0,14}\+\s*reson\s*(\d+)[^+\n]{0,14}(?:\+\s*act\s*(\d+))?/;
const AX_SLASH = /sig\s*(\d+)\s*\/\s*nov\s*(\d+)\s*\/\s*cred\s*(\d+)\s*\/\s*reson\s*(\d+)(?:\s*\/\s*act\s*(\d+))?/;
const AX_DOT = /(\d+)\s*·\s*(\d+)\s*\+\s*(\d+)\s*·\s*(\d+)\s*\+\s*(\d+)\s*·\s*(\d+)\s*\+\s*(\d+)\s*·\s*(\d+)\s*\+\s*(\d+)\s*·\s*(\d+)/;
function authoredAxes(note, type) {
  const cands = [];
  for (const [re, kind] of [[AX_LABEL, "labelled"], [AX_SLASH, "slash"], [AX_DOT, "dot"]]) {
    const m = note.match(re);
    if (m) cands.push({ at: m.index, kind, m });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.at - b.at);
  const { kind, m } = cands[0];
  if (kind === "dot") {
    const w = [Number(m[1]), Number(m[3]), Number(m[5]), Number(m[7]), Number(m[9])];
    return { axes: [Number(m[2]), Number(m[4]), Number(m[6]), Number(m[8]), Number(m[10])], weights: w, kind };
  }
  const act = m[5] === undefined ? null : Number(m[5]);
  const axes = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), act];
  if (act === null && WEIGHT_ROWS[type]?.[4] !== 0) return null;   // 缺 act 而该类型 act 有权重 → 无法核对
  return { axes, weights: null, kind };
}
function fixtureAudit() {
  const problems = [];
  const linesOf = (cap) => {
    const plan = mergePlan.find((p) => p.cap === cap);
    if (!plan) return [];
    return plan.out.filter((l) => l.trim() && !l.startsWith("//")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const live = [...Object.values(GATE).filter((v) => v != null), ...Object.values(GATE).filter((v) => v != null).map((v) => 2 * v), 2 * (SELECTION_FLOOR ?? 0)];
  const checkJudgement = (cap, who, rep, what = "") => {
    const note = `${rep?.note ?? ""}\n${what}`;
    if (!note.trim()) return;
    for (const cited of [...note.matchAll(/门槛\s*(\d{2,3})/g)].map((x) => Number(x[1]))) {
      if (!live.includes(cited)) problems.push(`[${cap}] ${who}: 引用门槛 ${cited}，industry/selection.ts 现值是 ${TIERS.slice(0, 3).map((t) => `${t}=${GATE[t]}`).join(" / ")}（入选线 ${[...new Set(TIERS.slice(0, 3).map((t) => 2 * GATE[t]))].join("/")}）→ 这句「入选/不入选」是按旧表下的结论`);
    }
    for (const cited of [...note.matchAll(/2×(?:T1_5|T1|T2)?\s*=?\s*(\d{3})\b/g)].map((x) => Number(x[1]))) {
      if (!live.includes(cited)) problems.push(`[${cap}] ${who}: 引用入选线 2×=…=${cited}，按现值只可能是 ${[...new Set(TIERS.slice(0, 3).map((t) => 2 * GATE[t]))].join("/")}（floor ${SELECTION_FLOOR} → ${2 * (SELECTION_FLOOR ?? 0)}）→ 这句结论要按现值重算`);
    }
    const type = Object.keys(WEIGHT_ROWS).find((t) => note.includes(t));
    if (!type) return;
    const citedRow = new RegExp(`${type}[^0-9\\n]{0,12}(\\d)/(\\d)/(\\d)/(\\d)/(\\d)`).exec(note);
    if (citedRow) {
      const w = citedRow.slice(1, 6).map(Number);
      if (w.join() !== WEIGHT_ROWS[type].join()) problems.push(`[${cap}] ${who}: note 写「${type} ${w.join("/")}」，industry/prompts/selection-score.md 的权重行是 ${WEIGHT_ROWS[type].join("/")} → 权重表被改过，这行的加权要按提示词重算`);
    }
    const a = authoredAxes(note, type);
    if (!a) return;
    const w = a.weights ?? WEIGHT_ROWS[type];
    if (a.weights && a.weights.join() !== WEIGHT_ROWS[type].join()) problems.push(`[${cap}] ${who}: note 里五轴的加权用了 ${a.weights.join("/")}，与 ${type} 的权重行 ${WEIGHT_ROWS[type].join("/")} 不一致`);
    const computed = w.reduce((s, x, i) => s + x * (a.axes[i] ?? 0), 0);
    const stored = Number(rep?.attentionScore);
    if (computed !== stored) problems.push(`[${cap}] ${who}: note 的第一次五轴 ${a.axes.join(",")}（${type} × ${w.join("/")}，${a.kind} 写法）算出 ${computed}，而行里存的是 ${stored} → 五轴是判断，分数必须等于它自己的加权结果`);
  };
  for (const cap of CAPS) {
    for (const o of linesOf(cap)) {
      if (!o.author || !String(o.author).trim()) problems.push(`[${cap}] ${o.id}: 行上没有 author（站点声明是「机器跑管道、人写判断」，/__brain/log 里这条就没有署名）`);
      for (const d of Array.isArray(o.dissent) ? o.dissent : []) {
        if (!d.author || !String(d.author).trim()) problems.push(`[${cap}] ${o.id} 的 dissent ${d.id}: 没有 author`);
        if (cap === "scores") checkJudgement(cap, `${o.id} 的 dissent ${d.id}`, d.reply, String(d.what ?? ""));
      }
      if (cap === "scores") checkJudgement(cap, o.id, o.reply, String(o.what ?? ""));
      // 词表耦合：normalizeTags 会静默丢掉词表外的标签，taxonomy.ts 由别人改，这里只报告不改别人文件。
      const tagReplies = cap === "structure" ? [o.reply?.tags] : cap === "understand" ? [o.reply?.tags] : [];
      for (const tags of tagReplies) {
        if (!Array.isArray(tags) || !taxonomy.ok || !normalizeTags) continue;
        const mapped = tags.map((t) => String(t).trim().replace(/^#/, "")).map((t) => TAX.synonyms[t] ?? TAX.synonyms[t.toLowerCase()] ?? t);
        const kept = normalizeTags(tags, { max: Math.max(tags.length, 1) });
        const dropped = tags.filter((t, i) => !kept.includes(mapped[i]));
        if (dropped.length) problems.push(`[${cap}] ${o.id}: tags ${dropped.map((t) => `「${t}」`).join("、")} 会被 normalizeTags 静默丢弃（词表 = ${TAX.categoryTags.length} 分类 + ${TAX.topicTags.length} 主题 + ${TAX.entityTags.length} 实体，现场 import industry/taxonomy.ts）`);
      }
      if (cap === "structure" && o.reply?.category && !TAX.categories.includes(o.reply.category)) problems.push(`[structure] ${o.id}: category "${o.reply.category}" 不在 industry/taxonomy.ts 的 CATEGORIES 里`);
      if (cap === "understand" && o.reply?.itemType && !TAX.itemTypes.includes(o.reply.itemType)) problems.push("[understand] " + o.id + ": itemType " + o.reply.itemType + " 不在 ITEM_TYPES 里");
    }
  }
  return problems;
}
const fixtureProblems = Object.keys(WEIGHT_ROWS).length || CAPS.size ? fixtureAudit() : [];

// ── Report ────────────────────────────────────────────────────────────────────────────────────
const summary = {
  corpusDir: CORPUS_DIR,
  fixturesDir: FIXTURES_DIR,
  outFile: DO_MATERIALS ? OUT_FILE : "(skipped)",
  mode: DRY ? "dry-run" : "apply",
  discoveredAtMode: DISCOVERED_AT,
  taxonomy,
  sourcesRegistered: SOURCES.size,
  fragments: frags.map((f) => ({ theme: f.theme, kind: f.kind, file: path.basename(f.file), dataLines: (f.kind === "materials" ? materialRows : brainRows).filter((r) => r.file === path.basename(f.file)).length })),
  fragmentParseErrors: fragParseErrors,
  fixturesBefore: Object.fromEntries([...CAPS].map((c) => [c, (readJsonl(path.join(FIXTURES_DIR, `${c}.jsonl`)).data.length)])),
  counts: fixtureCounts,
  totals: {
    materialsParsed: materialRows.length,
    materialsAccepted: materials.length,
    brainParsed: brainRows.length,
    added: added.length,
    skipped: skipped.length,
    rejected: rejected.length,
    warned: warns.length,
    collisions: collisions.length,
    noteDrift: noteDrifts.length,
    shadows: shadows.length,
    reportKeysDead: reportKeyChecks.length,
    withoutAuthor: noAuthor.length,
    strictFailures: strictHits.length,
    materialRejected: materialRejects.length,
    materialWarned: materialWarns.length,
    fixtureProblems: fixtureProblems.length,
    tierDrift: tierDrift.length,
    blockedMaterials: reportEntries.filter((e) => e.blocked).length,
    selectedMaterials: reportEntries.filter((e) => e.selected).length,
  },
  windowStats,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ ...summary, added, skipped, rejected: [...rejected, ...materialRejects.map((r) => ({ ...r }))], warns, notes, shadows, collisions, reportKeyChecks, dupCopies, strictHits, fixtureProblems, tierDrift }, null, 2));
} else {
  const pad = (s, n) => (s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(`GEOHOT merge-corpus — ${DRY ? "DRY RUN（没写任何文件）" : "APPLIED"} ｜ 片段目录 ${CORPUS_DIR}`);
  console.log(`taxonomy import: ${taxonomy.ok ? "OK（normalizeTags + CATEGORIES/ITEM_TYPES/ENTITIES 现场生效）" : `FAILED → 依赖词表的断言降级为未校验：${taxonomy.error}`}`);
  console.log(`信源登记表 industry/sources.json：${SOURCES.size} 条`);
  console.log(`\n片段清单（启动快照）`);
  console.log(`  ${pad("theme", 12)}${pad("kind", 11)}${pad("data lines", 11)}  file`);
  for (const f of summary.fragments) console.log(`  ${pad(f.theme, 12)}${pad(f.kind, 11)}${pad(String(f.dataLines), 11)}  ${f.file}`);

  console.log(`\nfixture 计数  capability          before  +added  after`);
  for (const [cap, c] of Object.entries(fixtureCounts)) console.log(`  ${pad(cap, 20)}${String(c.before).padStart(6)}${String(c.added).padStart(8)}${String(c.after).padStart(7)}`);
  console.log(`  ${pad("合计", 20)}${String(Object.values(fixtureCounts).reduce((n, c) => n + c.before, 0)).padStart(6)}${String(added.length).padStart(8)}${String(Object.values(fixtureCounts).reduce((n, c) => n + c.after, 0)).padStart(7)}`);

  if (REPORT) {
    const table = (title, rows, why) => {
      if (!rows.length) { console.log(`\n${title}: 无`); return; }
      console.log(`\n${title}（${rows.length}）`);
      for (const r of rows) console.log(`  - [${r.capability ?? r.what ?? "?"}] ${r.id}${r.theme ? ` (${r.theme})` : ""} @ ${r.at ?? `${r.file}#L${r.line}`}\n      ${why(r)}`);
    };
    table("ADDED", added, (r) => `tier=${r.tier}`);
    table("SKIPPED", skipped, (r) => r.why);
    console.log(`\nREJECTED（${rejected.length + materialRejects.length}）—— 每一条都是一个真实的集成缺陷`);
    for (const r of [...rejected, ...materialRejects]) console.log(`  - [${r.capability ?? "material"}] ${r.id ?? "(无 id)"} (${r.theme}) @ ${r.at ?? `${r.file}#L${r.line}`}\n      ${r.why}`);
    if (warns.length) {
      console.log(`\nWARNED（已并入，但每条都要语料 agent 复核，${warns.length}）`);
      for (const w of warns) console.log(`  - [${w.capability}] ${w.id} (${w.theme}) @ ${w.at}\n      ${w.why}`);
    } else console.log(`\nWARNED: 无`);
    if (materialWarns.length) {
      console.log(`\nMATERIAL WARNINGS（保留但必须有人处理，${materialWarns.length}）`);
      const bySource = new Map();
      for (const w of materialWarns) bySource.set(w.obj.sourceId, (bySource.get(w.obj.sourceId) ?? 0) + 1);
      for (const [sid, n] of bySource) console.log(`  - sourceId "${sid}"：${n} 条材料未登记在 industry/sources.json → ingest 会建成 T2/isolated 的隔离源`);
    }
    if (tierDrift.length) {
      console.log(`\n信源分级漂移（片段抄的 sourceTier ≠ industry/sources.json；材料与本报告都按登记表出数，${tierDrift.length}）`);
      for (const d of tierDrift) console.log(`  - ${d.id}（${d.sourceId}）@ ${d.at}: 片段写 ${d.from} → 登记表 ${d.to}`);
    }
    if (fixtureProblems.length) {
      console.log(`\nFIXTURE 自查（对 ${path.relative(REPO, FIXTURES_DIR)}/*.jsonl 的最终内容：署名 / note 里的门槛现值 / 五轴加权=attentionScore，${fixtureProblems.length}）`);
      for (const p of fixtureProblems) console.log(`  - ${p}`);
    } else {
      console.log(`\nFIXTURE 自查: 无（每行有 author；note/what 只引用 selection.ts 现值；每行第一次五轴按 selection-score.md 权重行算得出 attentionScore；structure/understand 的 tags 没有一个会被 normalizeTags 丢掉）`);
    }
    if (notes.length) {
      console.log(`\nNOTES（不阻断，${notes.length}）`);
      for (const nte of notes) console.log(`  - ${nte.where}: ${nte.note}`);
    }
    if (collisions.length) {
      console.log(`\nCOLLISIONS（告警，不拦：同 id 的片段↔fixture 答案漂移，fixture 那份继续答题；${collisions.filter((c) => !c.fatal).length}）`);
      for (const c of collisions.filter((x) => !x.fatal)) console.log(`  - [${c.cap}] ${c.id} (${c.theme}) @ ${c.at}\n      ${c.kind}，对 ${c.against}：${c.detail}`);
    }
    if (collisions.some((c) => c.fatal)) {
      console.log(`\nCOLLISIONS（默认就失败：身份键等价的两份人工判断，后一条一行都不生效，${collisions.filter((c) => c.fatal).length}）`);
      for (const c of collisions.filter((x) => x.fatal)) console.log(`  - [${c.cap}] ${c.id} (${c.theme}) @ ${c.at}\n      ${c.kind}，对 ${c.against}：${c.detail}`);
    }
    if (reportKeyChecks.length) {
      console.log(`\nREPORT KEYS（按 compose.ts 的渲染复算后，这些日报/周报判断的键触发不了，${reportKeyChecks.length}）`);
      for (const r of reportKeyChecks) console.log(`  - [${r.capability}] ${r.id} @ ${r.at}  死针 ${r.dead}/${r.total}\n      ${r.diagnosis.join("\n      ")}`);
    }
    if (shadows.length) {
      console.log(`\nSHADOWED（first-match-wins：同一份材料被多行命中，只有第一行生效；吞掉不同判断的那些默认就退出码 1，${shadows.length}）`);
      for (const s of shadows) console.log(`  - [${s.cap}] ${s.material}（${s.convention} 约定）→ 生效 ${s.winner} ⟶ 被吞 ${s.losers.join("、")}\n      ${s.detail}`);
    } else {
      console.log(`\nSHADOWED: 无（每份材料在每个能力上只被一行命中）`);
    }
  }
  console.log(`\n材料合并：解析 ${materialRows.length} 行 → 接受 ${materials.length} 行 → 写出 ${ingested.length} 行${DRY ? "（dry-run，未落盘）" : ` 到 ${OUT_FILE}`}`);
  console.log(`  discoveredAt=${DISCOVERED_AT}：now−2h 窗口内 ${windowStats.now2h} 条，钉在 publishedAt+2h ${windowStats.pinned} 条（48h 闸门 STALE_ON_DISCOVERY_MS）`);
  console.log(`  拒绝 ${materialRejects.length} 行，告警 ${materialWarns.length} 行。`);
  console.log(`\n静默失败账：warned=${warns.length} shadowed=${shadows.length}（其中 ${shadows.filter((s) => s.diverges).length} 条吞掉的是不同判断）collision=${collisions.length} noteDrift=${noteDrifts.length}（同 id 只差 note/what，不算冲突）死键告警=${warns.filter((w) => /命中 0 份/.test(w.why)).length} 无署名=${noAuthor.length} fixture自查=${fixtureProblems.length} 分级漂移=${tierDrift.length}（以 sources.json 为准）`);
  if (!DRY && DO_MERGE) console.log(`冲突表：${CONFLICTS_FILE}${STRICT ? "（--strict：以上任何一项非 0 都会退出 1）" : "（默认只记录不拦；要拦请加 --strict）"}`);
  if (STRICT) console.log(`--strict：计入失败的静默项 ${strictHits.length} 条`);
  if (written.length) console.log(`\n已写入 ${written.length} 个文件：${written.map((f) => path.relative(REPO, f)).join(", ")}`);
  console.log(`重跑：node tooling/merge-corpus.mjs --report   （幂等：第二次 added=0，文件字节不变）`);
}

const hard = rejected.length + materialRejects.length + fragParseErrors.length + strictHits.length + fixtureProblems.length;
process.exit(!taxonomy.ok && hard === 0 ? 2 : hard ? 1 : 0);
