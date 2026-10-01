// GEOHOT "编辑大脑" stub — a local OpenAI-compatible chat endpoint that answers with human-authored
// editorial judgements from tooling/fixtures/*.jsonl instead of calling a model.
//
// Why this exists: this deployment has no LLM API key, but the pipeline must stay intact
// (prefilter → two independent score passes → understand → structure → grouping → story digest →
// daily/weekly report). providers/llm.ts reads LLM_BASE_URL / LLM_API_KEY / LLM_MODEL at call time, so
// pointing those at this server runs the real code paths and the real selection gates with curated
// answers. Nothing in apps/ or packages/ is modified, and nothing is bypassed: an item is 精选 only when
// two score replies add up to twice the tier threshold in industry/selection.ts.
//
// It is a development tool, not part of the site: it never runs in the docker-compose deliverable and it
// holds no secrets. See tooling/brain-README.md.
//
//   node tooling/brain-stub.ts              start the server (http://127.0.0.1:3055/v1)
//   node tooling/brain-stub.ts --lint       validate every fixture line, no server
//   node tooling/brain-stub.ts --schema     print the JSON contract of each capability
//   node tooling/brain-stub.ts --anchors    print how each capability is recognised in a request
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");

const PORT = int(process.env.BRAIN_PORT, 3055);
const FIXTURES_DIR = process.env.BRAIN_FIXTURES_DIR ?? path.join(HERE, "fixtures");
const PROMPTS_DIR = process.env.BRAIN_PROMPTS_DIR ?? path.join(ROOT, "industry/prompts");
const LOG_SIZE = int(process.env.BRAIN_LOG_SIZE, 500);
/** Un-curated material: a low, honest score. 两次之和 ≥ 2×门槛 才精选，所以这个值永远进不了精选。 */
const SCORE_DEFAULT = clampInt(process.env.BRAIN_SCORE_DEFAULT, 20, 0, 100);
/** summarize 缺人工稿件时的做法：condense（规则压缩正文）| echo（只回原标题）| empty（不写，条目等待）。 */
const SUMMARIZE_DEFAULT = process.env.BRAIN_SUMMARIZE_DEFAULT ?? "condense";
/** group 缺人工判断时的做法：unrelated（不合并，安全）| lexical（字面相似才合并，需人工确认）。 */
const GROUP_DEFAULT = process.env.BRAIN_GROUP_DEFAULT ?? "unrelated";
const GROUP_LEXICAL_MIN = Number(process.env.BRAIN_GROUP_LEXICAL_MIN ?? 0.55);

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ── Capability registry ────────────────────────────────────────────────────────────────────────
// Each capability is the fixture file name (tooling/fixtures/<key>.jsonl), the industry prompt files whose
// wording identifies it in a request, and the JSON contract the caller's zod schema requires. The schemas
// live in packages/backend and are read from there at --lint time; here they are restated so the stub can
// refuse to send an answer that would blow up a receipt.
const CAPS: Record<string, Cap> = {
  prefilter: {
    prompts: ["prefilter"],
    contract: '{ "label": "PASS"|"BLOCK"|"UNKNOWN", "reason": "≤200字" }',
    note: "只有 BLOCK 会拦下材料；BLOCK 且材料缺失会被调用方降级为 UNKNOWN。",
  },
  scores: {
    prompts: ["selection-score"],
    contract: '{ "attentionScore": 0-100 整数, "scoreSecond"?: 0-100 整数 }',
    note: "框架独立调用两次（SCORE_CALLS=2）。第一次用 attentionScore，第二次用 scoreSecond ?? attentionScore。",
  },
  understand: {
    prompts: ["understand", "content-understanding"],
    contract: '{ "itemType": ITEM_TYPES 之一, "authorRole": "principal"|"observer"|"relayer", "tags": [≤12], "editorialJudgment": "≤400", "titleZh": "1-200", "summaryZh": "1-4000" }',
    note: "只有入选或接近入选（sum > 2×understandFloor）的材料会走这步。summaryZh 会被 finalizeCopy 压到 ≤200 字。",
  },
  summarize: {
    prompts: ["summarize-article", "summarize-short-post", "summarize-long-post"],
    contract: '纯文本： "title_zh: …\\nsummary_zh: …"（可选 body_zh: …），不是 JSON',
    note: "调用方 json:false + parseTranslateOutput，所以这一步的 content 必须是 title_zh/summary_zh 行。",
    text: true,
  },
  structure: {
    prompts: ["structure"],
    contract: '{ "category": CATEGORY_KEYS 之一|null, "tags": [≤12], "subjects": [≤6 个 ENTITIES id], "fact": {"title":"≤80","subject","action","object","occurredAt"}|null }',
    note: "不写读者可见文字。subjects 不在 ENTITIES 里会被调用方丢掉。",
  },
  group_batch: {
    prompts: ["group-batch"],
    contract: '{ "query": "≤400", "decisions": [{"candidateIncludes"|"id", "relation": "SAME_OCCURRENCE"|"SAME_STORY"|"UNRELATED"|"ROUNDUP", "confidence": 0-1, "note": "≤400"}] }',
    note: "decisions 里的 candidateIncludes 会和请求里每个候选块（【候选 C1】…）的文本比对，解析成真实 id。",
  },
  group_pair: {
    prompts: ["group-pair"],
    contract: '{ "a": "≤400", "b": "≤400", "relation": 同上, "difference": "≤400", "confidence": 0-1 }',
    note: "confirmMerge 与 story 合并复核都用它。默认 UNRELATED：没有人工判断绝不合并两个事件。",
  },
  group_signal: {
    prompts: ["group-signal"],
    contract: '{ "decisions": [{"candidateIncludes"|"id", "relation", "confidence"}] }',
    note: "帖子（社媒/列表）与候选事实的关系；SAME_STORY 需要 confidence ≥ 0.8 才算反应。",
  },
  digest: {
    prompts: ["story-digest"],
    contract: '{ "title": "≤120", "digest": "10-2000", "latest": "≤300" }',
    note: "事件综述。默认按时间把请求里的报道行压缩成综述，不补造事实。",
  },
  report_lead: {
    prompts: ["report-daily-lead"],
    contract: '{ "title": "≤120", "leadParagraph": "≤600", "highlights": [≤6 个条目的 1-based 编号] }',
    note: "日报导语与今日看点。",
  },
  report_period: {
    prompts: ["report-period"],
    contract: '{ "headline": "≤60", "overview": "≤1500", "themes": [{"heading":"≤60","summary":"≤800","refs":[编号]}] }',
    note: "周报/月报，themes 至少 1 个（调用方 .min(1) 没有兜底）。",
  },
  translate_body: {
    prompts: ["translate-body"],
    contract: '{ "t": ["每个片段一句译文"] }',
    note: "t 的长度必须等于请求 segments 的长度，否则调用方会二分重试。默认原样返回片段（不假译）。",
  },
  translate_post: {
    prompts: ["translate-post"],
    contract: '{ "t": ["一条帖子的译文"] }',
    note: "引用帖翻译，请求形状与 translate_body 相同。",
  },
};

interface Cap {
  prompts: string[];
  contract: string;
  note: string;
  /** summarize answers in the prompt's own text format instead of JSON. */
  text?: boolean;
  anchors?: string[];
}

const RELATIONS = ["SAME_OCCURRENCE", "SAME_STORY", "UNRELATED", "ROUNDUP"] as const;
type Relation = (typeof RELATIONS)[number];
const AUTHOR_ROLES = ["principal", "observer", "relayer"];
const PREFILTER_LABELS = ["PASS", "BLOCK", "UNKNOWN"];

// ── Vocabulary of the industry pack (read from source text, never copied here) ───────────────────
// The scoring/understanding/structure schemas take their enums from industry/taxonomy.ts, which another
// agent owns and will rewrite. Reading the live file keeps the stub honest: it can warn when a fixture
// names a category or item type that no longer exists instead of sending garbage.
interface Vocabulary { categories: string[]; itemTypes: string[]; entities: string[] }
function readVocabulary(): Vocabulary {
  const out: Vocabulary = { categories: [], itemTypes: [], entities: [] };
  let src = "";
  try {
    src = readFileSync(path.join(ROOT, "industry/taxonomy.ts"), "utf8");
  } catch {
    return out;
  }
  const categories = src.match(/export const CATEGORIES[\s\S]*?\n\] as const/);
  if (categories) out.categories = [...categories[0].matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]!);
  const itemTypes = src.match(/export const ITEM_TYPES\s*=\s*(\[[^\]]*\])/);
  if (itemTypes) out.itemTypes = [...itemTypes[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const entities = src.match(/export const ENTITIES[\s\S]*?\n\};/);
  if (entities) out.entities = [...entities[0].matchAll(/^\s{2}"?([a-z0-9][\w.-]*)"?\s*:\s*\{\s*name:/gm)].map((m) => m[1]!);
  return out;
}
let VOCAB = readVocabulary();

// ── Prompt fingerprints: how a capability is recognised in a request ─────────────────────────────
// The chat body carries no capability name (all capabilities share one model), so the stub identifies a
// capability from the prompt wording it received. Anchors are derived from the live prompt files, not
// hardcoded: every line that (a) has no {{value}} placeholder, (b) is at least 12 characters, and (c) is
// unique to one capability among the set, is an anchor for it. Lines shared by two capabilities (the
// {{> safety}} / {{> rules-*}} includes) drop out, which is what makes the classification unambiguous.
function expandPrompt(name: string, seen: string[] = []): string {
  let text = "";
  try {
    text = readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
  } catch {
    return "";
  }
  return text.replace(/\{\{(>\s*)?([A-Za-z][\w.-]*)\s*\}\}/g, (_t, include, key: string) => (include ? (seen.includes(key) ? "" : expandPrompt(key, [...seen, name])) : _t));
}

const ANCHOR_MIN_CHARS = 12;
function buildAnchors(): { anchors: Map<string, string[]>; problems: string[] } {
  const perCap = new Map<string, Set<string>>();
  for (const [cap, spec] of Object.entries(CAPS)) {
    const lines = new Set<string>();
    for (const file of spec.prompts) {
      for (const raw of expandPrompt(file).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.includes("{{") || line.replace(/\s/g, "").length < ANCHOR_MIN_CHARS) continue;
        lines.add(norm(line));
      }
    }
    perCap.set(cap, lines);
  }
  // Drop anything a second capability also claims.
  const counts = new Map<string, number>();
  for (const set of perCap.values()) for (const line of set) counts.set(line, (counts.get(line) ?? 0) + 1);
  const anchors = new Map<string, string[]>();
  const problems: string[] = [];
  for (const [cap, set] of perCap) {
    const own = [...set].filter((line) => (counts.get(line) ?? 0) === 1);
    anchors.set(cap, own);
    if (own.length < 2) problems.push(`${cap}: 只有 ${own.length} 条独有提示词锚点（提示词可能被改写或与他步重合）`);
  }
  return { anchors, problems };
}
let ANCHORS = new Map<string, string[]>();
let ANCHOR_PROBLEMS: string[] = [];

// Secondary layer: literals in packages/backend that a caller always sends. Stable (apps/ and packages/
// are off-limits to the industry rewrite) and used only when the prompt anchors are inconclusive.
const SEGMENTS_USER = (user: string) => /^\{\s*"segments"\s*:/.test(user.trim());
const MARKERS: Array<[string, (user: string, system: string) => boolean]> = [
  ["scores", (u) => u.includes("只输出 attentionScore")],
  ["understand", (u) => u.includes("一次返回全部六个字段")],
  ["prefilter", (u, s) => s.length > 0 && u.includes("【材料质量】")],
  ["structure", (u, s) => s.length > 0 && u.includes("<material>")],
  ["summarize", (_u, s) => s.length === 0],
  ["group_signal", (u) => u.includes("【帖子】")],
  ["group_batch", (u) => u.includes("【新报道】") || u.includes("【候选 C")],
  ["group_pair", (u) => u.includes("【报道 A】") && u.includes("【报道 B】")],
  ["digest", (u) => u.includes("事件当前标题")],
  ["report_period", (u) => /^本期：/m.test(u.trim())],
  ["translate_post", (u, s) => SEGMENTS_USER(u) && s.includes("帖子")],
  ["translate_body", (u) => SEGMENTS_USER(u)],
  ["report_lead", (u) => /^\s*1\.\s+\S+｜/m.test(u)],
];

function classify(system: string, user: string): { cap: string | null; via: string; hits: number; runnerUp: number } {
  const hay = norm(`${system}\n${user}`);
  const scored: Array<{ cap: string; hits: number }> = [];
  for (const [cap, anchors] of ANCHORS) {
    let hits = 0;
    for (const a of anchors) if (hay.includes(a)) hits++;
    if (hits > 0) scored.push({ cap, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  if (scored.length && (scored[0]!.hits >= 2 || (scored[0]!.hits >= 1 && scored.length === 1))) {
    return { cap: scored[0]!.cap, via: `anchors(${scored[0]!.hits})`, hits: scored[0]!.hits, runnerUp: scored[1]?.hits ?? 0 };
  }
  for (const [cap, test] of MARKERS) {
    if (test(user, system)) return { cap, via: `markers:${cap}`, hits: 0, runnerUp: 0 };
  }
  return { cap: null, via: "none", hits: scored[0]?.hits ?? 0, runnerUp: scored[1]?.hits ?? 0 };
}

// ── Text plumbing ────────────────────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, "");
const cp = (s: string) => Array.from(s);

/** Trim to a code-point budget the way the callers' zod schemas measure, so authored text never vanishes. */
function clampStr(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  const chars = cp(s);
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

/** The JSON-stringified user messages (prefilter sends JSON.stringify(text)) are read as the text they wrap. */
function decodeContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith('"') && t.endsWith('"')) {
      try {
        const inner = JSON.parse(t);
        if (typeof inner === "string") return { text: inner, images: 0 };
      } catch {
        /* not a JSON string literal; use as is */
      }
    }
    return { text: content, images: 0 };
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    let images = 0;
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (part?.type === "image_url") images++;
    }
    return { text: texts.join("\n"), images };
  }
  return { text: content == null ? "" : JSON.stringify(content), images: 0 };
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'）)、,，;；]+/g)].map((m) => m[0]!).slice(0, 6);
}
const TITLE_PATTERNS = [/【标题】\s*([^\n]+)/g, /标题[：:]\s*([^\n]+)/g, /原始标题[：:]\s*([^\n]+)/g, /事实标题：([^）\n]+)/g, /事件当前标题[：:]\s*([^\n]+)/g];
function extractTitles(text: string): string[] {
  const out: string[] = [];
  for (const re of TITLE_PATTERNS) for (const m of text.matchAll(re)) {
    const t = m[1]!.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 12);
}
/** The candidate blocks of a grouping prompt: 【候选 C1】… through to the next block. */
function candidateBlocks(user: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const re = /【候选\s*(C\d+)】/g;
  const hits = [...user.matchAll(re)];
  hits.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < hits.length ? (hits[i + 1]!.index ?? user.length) : user.length;
    out.push({ id: m[1]!, text: user.slice(start, end) });
  });
  return out;
}
function segmentsOf(user: string): string[] | null {
  const t = user.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t) as { segments?: unknown };
    return Array.isArray(parsed.segments) ? parsed.segments.map((s) => String(s ?? "")) : null;
  } catch {
    return null;
  }
}
/** The numbered entry list the report prompts are built from (compose.ts writeLead / periodPrompt). */
function entryLines(user: string): Array<{ n: number; section: string; title: string; summary: string }> {
  const out: Array<{ n: number; section: string; title: string; summary: string }> = [];
  for (const raw of user.split(/\r?\n/)) {
    const m = raw.trim().match(/^(\d+)\.\s+(?:\[([^\]]+)\]\s*)?(.*)$/);
    if (!m) continue;
    const rest = m[3]!;
    const split = rest.split("｜");
    out.push({ n: Number(m[1]), section: (m[2] ?? "").trim(), title: (split[0] ?? "").trim(), summary: split.slice(1).join("｜").trim() });
  }
  return out;
}
/** The report lines a digest is written from: 时间｜来源｜标题｜摘要. */
function reportLines(user: string): Array<{ when: string; source: string; title: string; summary: string }> {
  const out: Array<{ when: string; source: string; title: string; summary: string }> = [];
  for (const raw of user.split(/\r?\n/)) {
    const line = raw.replace(/^【新】/, "").trim();
    if (!line.includes("｜")) continue;
    const parts = line.split("｜").map((p) => p.trim());
    if (parts.length < 3) continue;
    out.push({ when: parts[0]!, source: parts[1]!, title: parts[2]!, summary: parts.slice(3).join("｜") });
  }
  return out;
}

/** Lexical stand-in used only when GROUP_DEFAULT=lexical: character bigram overlap (same as relate.ts). */
function lexicalSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const chars = cp(s.replace(/\s+/g, ""));
    return new Set(chars.map((_c, i) => chars.slice(i, i + 2).join("")).filter((g) => g.length === 2));
  };
  const g = grams(a), h = grams(b);
  if (!g.size || !h.size) return 0;
  let inter = 0;
  for (const x of g) if (h.has(x)) inter++;
  return inter / Math.min(g.size, h.size);
}

/** Deterministic condensation of supplied text: whole sentences only, nothing invented. */
function condense(text: string, maxChars = 190, maxSentences = 3): string {
  const clean = text.replace(/<[^>]+>/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\s*\n\s*/g, " ").trim();
  const sentences = (clean.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? [clean]).map((s) => s.trim()).filter(Boolean);
  const informative = sentences.filter((s) => {
    const body = s.replace(/[【】\[\]()（）]/g, "");
    if (body.length < 8) return false;
    if (/^(来源|发布时间|标题|正文|原文链接|材料质量|引用|请按|只输出|以下)/.test(body.trim())) return false;
    return true;
  });
  const picked: string[] = [];
  let chars = 0;
  for (const s of informative.slice(0, maxSentences)) {
    if (picked.length && chars + s.length > maxChars) break;
    picked.push(s);
    chars += s.length;
  }
  const text2 = picked.join(" ").replace(/([。！？])\s*$/, "$1");
  return clampStr(text2 || clean, maxChars);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
interface Fixture {
  id: string;
  capability?: string;
  /** Readable description of the material this answer is for. Not used for matching. */
  what?: string;
  /**
   * Optional, only read by --lint: the material as the caller would hand it to the copy guards
   * (enforceIdentity / compactAnswerFirstSummary live in packages/backend and cannot be imitated here).
   * Fill it with the source title + body you wrote the copy from, and --lint tells you whether the
   * guard would throw the summary away because the copy names an institution the material does not.
   */
  guard?: { title?: string; text?: string; sourceName?: string; sourceKind?: string; url?: string };
  /**
   * Identity keys, never prompt hashes. `includes` / `urlIncludes` / `titleIncludes` / `textIncludes` are
   * substrings of the material as it appears in the user message (all of them must be present; they are
   * aliases that say what kind of key it is). `queryIncludes` only looks at the new report in a grouping
   * call, `candidateIncludes` only at the candidate blocks, `anyIncludes` needs one of them,
   * `notIncludes` must be absent. Matching is whitespace- and case-insensitive, first line wins.
   */
  match: {
    includes?: string[];
    urlIncludes?: string | string[];
    titleIncludes?: string | string[];
    textIncludes?: string | string[];
    queryIncludes?: string | string[];
    candidateIncludes?: string | string[];
    anyIncludes?: string[];
    notIncludes?: string[];
  };
  reply: Record<string, unknown>;
  author?: string;
  enabled?: boolean;
}

interface FixtureFile { cap: string; lines: Fixture[]; errors: Array<{ line: number; error: string; raw: string }>; mtime: number }
const fixtureCache = new Map<string, FixtureFile>();

function listToArray(v: string | string[] | undefined): string[] {
  return v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

function readFixtureFile(cap: string): FixtureFile {
  const file = path.join(FIXTURES_DIR, `${cap}.jsonl`);
  const empty: FixtureFile = { cap, lines: [], errors: [], mtime: 0 };
  if (!existsSync(file)) return empty;
  const stat = statSync(file);
  const cached = fixtureCache.get(cap);
  if (cached && cached.mtime === stat.mtimeMs) return cached;
  const lines: Fixture[] = [];
  const errors: FixtureFile["errors"] = [];
  const raw = readFileSync(file, "utf8").split(/\r?\n/);
  raw.forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) return;
    try {
      const parsed = JSON.parse(trimmed) as Fixture;
      if (!parsed || typeof parsed !== "object" || !parsed.match || typeof parsed.match !== "object") throw new Error("缺少 match 对象");
      if (!parsed.reply || typeof parsed.reply !== "object") throw new Error("缺少 reply 对象");
      if (!parsed.id) throw new Error("缺少 id");
      lines.push({ ...parsed, capability: parsed.capability ?? cap });
    } catch (error) {
      errors.push({ line: i + 1, error: String(error), raw: trimmed.slice(0, 160) });
    }
  });
  const next = { cap, lines, errors, mtime: stat.mtimeMs };
  fixtureCache.set(cap, next);
  return next;
}

/** Every fixture file on disk, so a new capability file needs no code change. */
function fixtureCapabilities(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
}

interface MatchResult { fixture: Fixture | null; file: FixtureFile | null }
/** The three scopes a `match` predicate can be tested in, all whitespace- and case-insensitive. */
interface Hay { user: string; query: string; candidates: string }
function findFixture(cap: string, h: Hay): MatchResult {
  const file = readFixtureFile(cap);
  for (const fixture of file.lines) {
    if (fixture.enabled === false) continue;
    const m = fixture.match;
    const all = [...listToArray(m.includes), ...listToArray(m.urlIncludes), ...listToArray(m.titleIncludes), ...listToArray(m.textIncludes)].map(norm).filter(Boolean);
    const query = listToArray(m.queryIncludes).map(norm).filter(Boolean);
    const cand = listToArray(m.candidateIncludes).map(norm).filter(Boolean);
    const any = listToArray(m.anyIncludes).map(norm).filter(Boolean);
    const none = listToArray(m.notIncludes).map(norm).filter(Boolean);
    if (
      all.every((needle) => h.user.includes(needle))
      && query.every((needle) => h.query.includes(needle))
      && cand.every((needle) => h.candidates.includes(needle))
      && (any.length === 0 || any.some((needle) => h.user.includes(needle)))
      && none.every((needle) => !h.user.includes(needle))
    ) return { fixture, file };
  }
  return { fixture: null, file };
}

// ── Replies: authored fixture first, then the capability's default ────────────────────────────────
interface Ctx { system: string; user: string; hay: string; titles: string[]; urls: string[]; pass: number; warnings: string[] }

function relationOf(value: unknown, warn: (m: string) => void): Relation {
  const r = String(value ?? "").trim().toUpperCase();
  if ((RELATIONS as readonly string[]).includes(r)) return r as Relation;
  warn(`relation "${r}" 非法，按 UNRELATED`);
  return "UNRELATED";
}
function confidenceOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/** decisions authored against candidates, resolved to the ids the request actually offered. */
function resolveDecisions(reply: Record<string, unknown>, ctx: Ctx, withNote: boolean): Array<Record<string, unknown>> {
  const blocks = candidateBlocks(ctx.user);
  const authored = Array.isArray(reply.decisions) ? (reply.decisions as Array<Record<string, unknown>>) : [];
  const out: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    const blockHay = norm(block.text);
    const rule =
      authored.find((d) => (d.id != null && String(d.id).toUpperCase() === block.id)) ??
      authored.find((d) => listToArray((d.candidateIncludes ?? d.includes) as string | string[]).map(norm).filter(Boolean).every((needle) => blockHay.includes(needle)));
    const d = (rule ?? {}) as Record<string, unknown>;
    const decision: Record<string, unknown> = { id: block.id };
    if (rule) {
      decision.relation = relationOf(d.relation, (msg) => ctx.warnings.push(`${block.id}: ${msg}`));
      decision.confidence = confidenceOf(d.confidence);
    } else if (GROUP_DEFAULT === "lexical") {
      const queryTitle = ctx.titles[0] ?? "";
      const sim = lexicalSimilarity(queryTitle, block.text);
      decision.relation = queryTitle && sim >= GROUP_LEXICAL_MIN ? "SAME_OCCURRENCE" : "UNRELATED";
      decision.confidence = Number(sim.toFixed(3));
      ctx.warnings.push(`${block.id}: rule:lexical 相似度 ${sim.toFixed(3)} → ${decision.relation}`);
    } else {
      decision.relation = "UNRELATED";
      decision.confidence = 0;
    }
    if (withNote) decision.note = clampStr(rule ? d.note : "", 400);
    out.push(decision);
  }
  return out;
}

function pairTitles(user: string): { a: string; b: string } {
  const grab = (label: string) => {
    const m = new RegExp(`【报道 ${label}】[\\s\\S]*?标题[：:]\\s*([^\\n]+)`).exec(user);
    return m ? m[1]!.trim() : "";
  };
  return { a: grab("A"), b: grab("B") };
}

const buildReply: Record<string, (reply: Record<string, unknown>, ctx: Ctx) => Record<string, unknown>> = {
  prefilter: (r) => ({
    label: PREFILTER_LABELS.includes(String(r.label ?? "").trim().toUpperCase()) ? String(r.label).trim().toUpperCase() : "UNKNOWN",
    reason: clampStr(r.reason ?? "", 200),
  }),
  scores: (r, ctx) => {
    const first = clampInt(r.attentionScore === undefined ? String(SCORE_DEFAULT) : String(r.attentionScore), SCORE_DEFAULT, 0, 100);
    const second = r.scoreSecond === undefined ? undefined : clampInt(String(r.scoreSecond), first, 0, 100);
    return { attentionScore: ctx.pass >= 2 ? (second ?? first) : first };
  },
  understand: (r, ctx) => {
    const itemType = String(r.itemType ?? "");
    // The vocabulary belongs to industry/taxonomy.ts (another agent's file, and it will move to the
    // geography types): a mismatch is reported, never silently rewritten. The caller's zod enum is the
    // authority and will reject an answer that really does not exist.
    if (itemType && VOCAB.itemTypes.length && !VOCAB.itemTypes.includes(itemType)) ctx.warnings.push(`itemType "${itemType}" 不在当前 ITEM_TYPES(${VOCAB.itemTypes.join("/")})，调用方会拒绝`);
    return {
      itemType: itemType || (VOCAB.itemTypes[0] ?? ""),
      authorRole: AUTHOR_ROLES.includes(String(r.authorRole)) ? r.authorRole : "relayer",
      tags: arrOf(r.tags, 12),
      editorialJudgment: clampStr(r.editorialJudgment ?? "", 400),
      titleZh: clampStr(r.titleZh ?? "", 200),
      summaryZh: clampStr(r.summaryZh ?? "", 4000),
    };
  },
  structure: (r, ctx) => {
    const category = r.category == null ? null : String(r.category);
    if (category !== null && VOCAB.categories.length && !VOCAB.categories.includes(category)) ctx.warnings.push(`category "${category}" 不在 CATEGORIES 里，调用方会归为 null`);
    const fact = r.fact && typeof r.fact === "object" ? (r.fact as Record<string, unknown>) : null;
    return {
      category,
      tags: arrOf(r.tags, 12),
      subjects: arrOf(r.subjects, 6),
      fact: fact === null ? null : {
        title: clampStr(fact.title ?? "", 80),
        subject: fact.subject == null ? null : clampStr(fact.subject, 80),
        action: fact.action == null ? null : clampStr(fact.action, 80),
        object: fact.object == null ? null : clampStr(fact.object, 160),
        occurredAt: fact.occurredAt == null ? null : String(fact.occurredAt),
      },
    };
  },
  summarize: (r) => r,
  group_batch: (reply, ctx) => ({ query: clampStr(reply.query ?? ctx.titles[0] ?? "", 400), decisions: resolveDecisions(reply, ctx, true) }),
  group_signal: (reply, ctx) => ({ decisions: resolveDecisions(reply, ctx, false) }),
  group_pair: (reply, ctx) => {
    const { a, b } = pairTitles(ctx.user);
    return {
      a: clampStr(reply.a ?? a, 400),
      b: clampStr(reply.b ?? b, 400),
      relation: relationOf(reply.relation ?? (GROUP_DEFAULT === "lexical" ? "SAME_OCCURRENCE" : "UNRELATED"), (msg) => ctx.warnings.push(msg)),
      difference: clampStr(reply.difference ?? "", 400),
      confidence: reply.relation === undefined && GROUP_DEFAULT !== "lexical" ? 0 : confidenceOf(reply.confidence),
    };
  },
  digest: (r, ctx) => ({
    title: clampStr(r.title ?? /事件当前标题[：:]\s*([^\n]+)/.exec(ctx.user)?.[1] ?? "", 120),
    digest: clampStr(r.digest ?? "", 2000),
    latest: clampStr(r.latest ?? "", 300),
  }),
  report_lead: (r) => ({ title: clampStr(r.title ?? "", 120), leadParagraph: clampStr(r.leadParagraph ?? "", 600), highlights: arrOf(r.highlights, 6) }),
  report_period: (r) => ({
    headline: clampStr(r.headline ?? "", 60),
    overview: clampStr(r.overview ?? "", 1500),
    themes: arrOf(r.themes, 6).map((t) => {
      const theme = (t ?? {}) as Record<string, unknown>;
      return { heading: clampStr(theme.heading ?? "", 60), summary: clampStr(theme.summary ?? "", 800), refs: arrOf(theme.refs, 8) };
    }),
  }),
  translate_body: (r, ctx) => ({ t: translateArray(r, ctx) }),
  translate_post: (r, ctx) => ({ t: translateArray(r, ctx) }),
};

function arrOf(value: unknown, max: number): unknown[] {
  return (Array.isArray(value) ? value : []).slice(0, max);
}

/** The answer's `t` must line up with the requested segments one for one, or the caller splits the batch. */
function translateArray(reply: Record<string, unknown>, ctx: Ctx): string[] {
  const segments = segmentsOf(ctx.user) ?? [];
  const map = Array.isArray(reply.segmentMap) ? (reply.segmentMap as Array<Record<string, unknown>>) : [];
  const fixed = Array.isArray(reply.t) ? reply.t.map(String) : null;
  return segments.map((segment, i) => {
    const rule = map.find((m) => listToArray((m.includes ?? m.segmentIncludes) as string | string[]).map(norm).filter(Boolean).every((needle) => norm(segment).includes(needle)));
    if (rule?.zh != null) return String(rule.zh);
    if (fixed && fixed.length === segments.length) return fixed[i]!;
    if (fixed && fixed[i] != null) return fixed[i]!;
    return segment;
  });
}

const buildDefault: Record<string, (ctx: Ctx) => { reply: Record<string, unknown>; rule: string }> = {
  prefilter: () => ({ reply: { label: "PASS", reason: "默认放行：尚无人工预筛记录，按宽召回保留待判" }, rule: "rule:pass" }),
  scores: () => ({ reply: { attentionScore: SCORE_DEFAULT }, rule: `rule:score-default(${SCORE_DEFAULT})` }),
  structure: () => ({ reply: { category: null, tags: [], subjects: [], fact: null }, rule: "rule:unstructured" }),
  summarize: (ctx) => {
    const body = /正文内容[：:]\s*([\s\S]+)$/.exec(ctx.user)?.[1] ?? /【完整正文】\s*([\s\S]+)$/.exec(ctx.user)?.[1] ?? ctx.user;
    const title = ctx.titles[0] ?? "";
    if (SUMMARIZE_DEFAULT === "empty") return { reply: { titleZh: "", summaryZh: "", bodyZh: "" }, rule: "rule:empty" };
    if (SUMMARIZE_DEFAULT === "echo") return { reply: { titleZh: title, summaryZh: "", bodyZh: "" }, rule: "rule:echo-title" };
    return { reply: { titleZh: title, summaryZh: condense(body), bodyZh: "" }, rule: "rule:condense" };
  },
  understand: (ctx) => {
    const body = /【正文】\s*([\s\S]+?)(?:【材料质量】|$)/.exec(ctx.user)?.[1] ?? ctx.user;
    return {
      reply: { itemType: process.env.BRAIN_UNDERSTAND_ITEM_TYPE ?? VOCAB.itemTypes[0] ?? "", authorRole: "relayer", tags: [], editorialJudgment: "", titleZh: ctx.titles[0] ?? "", summaryZh: condense(body) },
      rule: "rule:condense-understand",
    };
  },
  group_batch: (ctx) => ({ reply: { query: ctx.titles[0] ?? "", decisions: [] }, rule: `rule:group-${GROUP_DEFAULT}` }),
  group_signal: (ctx) => ({ reply: { decisions: [] }, rule: `rule:group-${GROUP_DEFAULT}` }),
  group_pair: () => ({ reply: {}, rule: `rule:pair-${GROUP_DEFAULT}` }),
  digest: (ctx) => {
    const lines = reportLines(ctx.user);
    const body = lines.length
      ? clampStr(`本事件目前由 ${lines.length} 篇报道构成（按时间，只复述报道内容，不做推断）：${lines.map((l, i) => `${i + 1}. ${l.when} ${l.source}《${l.title}》`).join("；")}。`, 2000)
      : "";
    return {
      reply: {
        title: /事件当前标题[：:]\s*([^\n]+)/.exec(ctx.user)?.[1]?.trim() ?? "",
        digest: body.length >= 10 ? body : "暂无可复述的报道内容，后续以各方报道为准。",
        latest: clampStr(lines.length ? `${lines[lines.length - 1]!.when} ${lines[lines.length - 1]!.source}：${lines[lines.length - 1]!.title}` : "", 300),
      },
      rule: "rule:chronology",
    };
  },
  report_lead: (ctx) => {
    const entries = entryLines(ctx.user);
    const top = entries.slice(0, 3).map((e) => e.title).filter(Boolean);
    return {
      reply: {
        title: clampStr(entries[0]?.title ?? "", 60),
        leadParagraph: clampStr(`本期共 ${entries.length} 条入选动态：${top.join("；")}。`, 600),
        highlights: entries.slice(0, Math.min(5, entries.length)).map((e) => e.n),
      },
      rule: "rule:list-lead",
    };
  },
  report_period: (ctx) => {
    const entries = entryLines(ctx.user);
    const bySection = new Map<string, number[]>();
    for (const e of entries) {
      const key = e.section || "其他";
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(e.n);
    }
    const themes = [...bySection.entries()].slice(0, 6).map(([heading, refs]) => ({
      heading: clampStr(heading, 60),
      summary: clampStr(`本主题 ${refs.length} 条（条目 ${refs.join("、")}），按入选分数排列。`, 800),
      refs,
    }));
    const period = /^本期：\s*([^\n]+)/.exec(ctx.user.trim())?.[1]?.trim() ?? "";
    return {
      reply: {
        headline: "",
        overview: clampStr(`${period ? `本期覆盖 ${period}，` : ""}共 ${entries.length} 条入选动态，分 ${themes.length} 个主题列出。`, 1500),
        themes: themes.length ? themes : [{ heading: "本期", summary: clampStr(`本期入选 ${entries.length} 条。`, 800), refs: [] }],
      },
      rule: "rule:list-themes",
    };
  },
  translate_body: (ctx) => ({ reply: {}, rule: "rule:passthrough" }),
  translate_post: (ctx) => ({ reply: {}, rule: "rule:passthrough" }),
};

class Unsupported extends Error {}

// ── Score pass counting (the framework calls the scorer twice with an identical body) ──────────────
/** Mirrors analyze.ts SCORE_CALLS: the two independent passes are counted per identical request. */
const SCORE_CALLS = 2;
const passCounts = new Map<string, number>();
function passFor(cap: string, key: string): number {
  if (cap !== "scores") return 1;
  const n = (passCounts.get(key) ?? 0) + 1;
  if (passCounts.size > 20_000) for (const oldest of passCounts.keys()) { passCounts.delete(oldest); if (passCounts.size <= 10_000) break; }
  passCounts.set(key, n);
  // Cycles 1,2,1,2… so a re-evaluation of the same material gets the same authored pair of scores.
  return ((n - 1) % SCORE_CALLS) + 1;
}

// ── Audit log ────────────────────────────────────────────────────────────────────────────────────
interface LogEntry {
  seq: number;
  at: string;
  status: number;
  capability: string | null;
  via: string;
  fixtureId: string | null;
  author: string | null;
  rule: string | null;
  pass: number | null;
  model: unknown;
  identity: { urls: string[]; titles: string[] };
  request: { systemChars: number; userChars: number; images: number; jsonMode: boolean; temperature: unknown; maxTokens: unknown };
  reply: string;
  warnings: string[];
  error?: string;
}
const LOG: LogEntry[] = [];
let seq = 0;
function log(entry: Omit<LogEntry, "seq" | "at">): LogEntry {
  const full = { ...entry, seq: ++seq, at: new Date().toISOString() };
  LOG.push(full);
  if (LOG.length > LOG_SIZE) LOG.splice(0, LOG.length - LOG_SIZE);
  return full;
}

// ── The chat completion itself ───────────────────────────────────────────────────────────────────
function answer(body: Record<string, unknown>): { content: string; entry: LogEntry } {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const system = messages.filter((m) => m.role === "system").map((m) => decodeContent(m.content).text).join("\n");
  const userMsgs = messages.filter((m) => m.role !== "system");
  const decoded = userMsgs.map((m) => decodeContent(m.content));
  const user = decoded.map((d) => d.text).join("\n");
  const images = decoded.reduce((total, d) => total + d.images, 0);

  const { cap, via, hits, runnerUp } = classify(system, user);
  const request = {
    systemChars: system.length, userChars: user.length, images,
    jsonMode: (body.response_format as Record<string, unknown> | undefined)?.type === "json_object",
    temperature: body.temperature, maxTokens: body.max_tokens,
  };
  if (!cap) {
    const error = `brain-stub 认不出这是哪个能力（anchors top=${hits}, runner-up=${runnerUp}）。已拒绝回答而不是编造。`;
    const entry = log({ status: 400, capability: null, via, fixtureId: null, author: null, rule: null, pass: null, model: body.model, identity: { urls: extractUrls(user), titles: extractTitles(user).slice(0, 3) }, request, reply: "", warnings: [`锚点命中：最高 ${hits}，次高 ${runnerUp}`], error });
    throw new HttpError(400, error, entry);
  }

  const titles = extractTitles(user);
  const urls = extractUrls(user);
  // Fixture matching looks only in the user message (the material), never in the system prompt: identity
  // comes from the article, and prompt wording ("主震与余震"…) must not accidentally satisfy a rule.
  // In a grouping call the user message also carries the candidate facts, so a rule written for one report
  // can be scoped to the query block or to the candidates instead of the whole message.
  const blocks = candidateBlocks(user);
  const hay: Hay = {
    user: norm(user),
    query: norm(blocks.length ? user.slice(0, user.search(/【候选\s*C\d+】/)) : user),
    candidates: norm(blocks.map((b) => b.text).join("\n")),
  };
  const passKey = createHash("sha256").update(`${String(body.model)}\0${norm(system)}\0${norm(user)}`).digest("hex").slice(0, 16);
  const pass = passFor(cap, passKey);
  const warnings: string[] = [];
  const ctx: Ctx = { system, user, hay: hay.user, titles, urls, pass, warnings };

  const { fixture, file } = findFixture(cap, hay);
  let source: Record<string, unknown>;
  let rule: string | null = null;
  let reply: Record<string, unknown>;
  try {
    if (fixture) {
      source = { ...fixture.reply };
    } else {
      const built = buildDefault[cap]?.(ctx);
      if (!built) throw new Unsupported(`这个能力还没有默认策略（${cap}），必须人工撰写 fixture`);
      source = built.reply;
      rule = built.rule;
    }
    // Authored and default answers go through the same shaping, clamping and validation.
    reply = buildReply[cap]!(source, ctx);
  } catch (error) {
    const message = error instanceof Unsupported || error instanceof HttpError ? error.message : String(error);
    const entry = log({ status: 422, capability: cap, via, fixtureId: fixture?.id ?? null, author: fixture?.author ?? null, rule, pass, model: body.model, identity: { urls, titles: titles.slice(0, 3) }, request, reply: "", warnings, error: message });
    throw new HttpError(422, `brain-stub 拒绝回答 ${cap}：${message}`, entry);
  }
  if (file?.errors.length) warnings.push(`${file.cap}.jsonl 有 ${file.errors.length} 行读失败`);

  const content = CAPS[cap]!.text
    ? [`title_zh: ${String(reply.titleZh ?? "")}`, `summary_zh: ${String(reply.summaryZh ?? "")}`, reply.bodyZh ? `body_zh: ${String(reply.bodyZh)}` : ""].filter(Boolean).join("\n")
    : JSON.stringify(reply);

  const entry = log({
    status: 200, capability: cap, via, fixtureId: fixture?.id ?? null, author: fixture?.author ?? null, rule, pass, model: body.model,
    identity: { urls, titles: titles.slice(0, 3) }, request,
    reply: content.length > 4000 ? `${content.slice(0, 4000)}…(${content.length})` : content,
    warnings,
  });
  return { content, entry };
}

class HttpError extends Error {
  readonly status: number;
  readonly entry: LogEntry | null;
  constructor(status: number, message: string, entry: LogEntry | null = null) {
    super(message);
    this.status = status;
    this.entry = entry;
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────────────────────────
function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function summary(): Record<string, unknown> {
  const caps = [...new Set([...Object.keys(CAPS), ...fixtureCapabilities()])];
  const fixtures = caps.map((cap) => {
    const file = readFixtureFile(cap);
    return { cap, fixtures: file.lines.length, fixtureErrors: file.errors.length, knownCapability: !!CAPS[cap], anchors: ANCHORS.get(cap)?.length ?? 0, hasDefault: !!buildDefault[cap] };
  });
  return {
    ok: true,
    role: "geohot-brain-stub",
    port: PORT,
    fixturesDir: FIXTURES_DIR,
    promptsDir: PROMPTS_DIR,
    promptsPresent: Object.values(CAPS).every((c) => c.prompts.every((p) => existsSync(path.join(PROMPTS_DIR, `${p}.md`)))),
    vocabulary: { categories: VOCAB.categories, itemTypes: VOCAB.itemTypes, entityIds: VOCAB.entities.length },
    defaults: { scoreDefault: SCORE_DEFAULT, summarize: SUMMARIZE_DEFAULT, group: GROUP_DEFAULT, groupLexicalMin: GROUP_LEXICAL_MIN },
    anchorProblems: ANCHOR_PROBLEMS,
    unknownCapabilities: fixtures.filter((f) => !f.knownCapability).map((f) => f.cap),
    fixtures,
    logged: LOG.length,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "GET" && (route === "/healthz" || route === "/health")) return json(res, 200, summary());
    if (req.method === "GET" && route === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: [{ id: "geohot-brain", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "geohot-brain-stub" }],
        brain: { note: "本地编辑大脑 fixture 服务；模型名会被忽略，任何非空 LLM_MODEL 都可以。", capabilities: Object.fromEntries(Object.entries(CAPS).map(([k, c]) => [k, c.contract])) },
      });
    }
    if (req.method === "GET" && route === "/__brain/log") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, LOG_SIZE);
      const cap = url.searchParams.get("capability");
      const since = Number(url.searchParams.get("since") ?? 0);
      const entries = LOG.filter((e) => (!cap || e.capability === cap) && e.seq > since).slice(-limit);
      return json(res, 200, { total: seq, shown: entries.length, capabilityFilter: cap, entries: entries.map((e) => ({ ...e, request: undefined })) });
    }
    if (req.method === "GET" && route === "/__brain/summary") return json(res, 200, summary());
    if (req.method === "GET" && route === "/__brain/fixtures") {
      return json(res, 200, Object.fromEntries([...new Set([...Object.keys(CAPS), ...fixtureCapabilities()])].map((cap) => [cap, readFixtureFile(cap).lines])));
    }
    if (req.method === "POST" && route === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (body.stream === true) throw new HttpError(400, "brain-stub 只支持非流式（stream:false），请把 LLM 客户端设为非流式");
      const { content, entry } = answer(body);
      const promptChars = entry.request.systemChars + entry.request.userChars;
      return json(res, 200, {
        id: `chatcmpl-brain-${entry.seq}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: String(body.model ?? "geohot-brain"),
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: Math.ceil(promptChars / 3), completion_tokens: Math.ceil(content.length / 3), total_tokens: Math.ceil((promptChars + content.length) / 3), brain: { capability: entry.capability, fixture: entry.fixtureId, author: entry.author, rule: entry.rule, pass: entry.pass } },
      });
    }
    if (req.method === "POST") throw new HttpError(404, `brain-stub 只实现了 POST /v1/chat/completions（收到 ${req.method} ${route}）`);
    return json(res, 404, { error: { message: `未知路由 ${req.method} ${route}`, type: "brain_stub_route" } });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(res, error.status, { error: { message: error.message, type: "brain_stub", brain: { capability: error.entry?.capability ?? null, via: error.entry?.via ?? null, fixturesDir: FIXTURES_DIR, hint: "在 tooling/fixtures/<capability>.jsonl 里补一条，或检查 industry/prompts 是否被改名" } } });
    }
    log({ status: 500, capability: null, via: "error", fixtureId: null, author: null, rule: null, pass: null, model: null, identity: { urls: [], titles: [] }, request: { systemChars: 0, userChars: 0, images: 0, jsonMode: false, temperature: null, maxTokens: null }, reply: "", warnings: [], error: String(error) });
    return json(res, 500, { error: { message: String(error), type: "brain_stub_internal" } });
  }
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 32_000_000) reject(new HttpError(413, "请求体超过 32MB"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

function refreshClassification(): void {
  VOCAB = readVocabulary();
  const built = buildAnchors();
  ANCHORS = built.anchors;
  ANCHOR_PROBLEMS = built.problems;
}

const anchorSignature = () => [...ANCHORS.entries()].map(([cap, list]) => `${cap}:${list.length}`).sort().join("|");

// ── Modes ────────────────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2];

if (mode === "--schema") {
  console.log(JSON.stringify({ capabilities: Object.fromEntries(Object.entries(CAPS).map(([k, c]) => [k, { fixtureFile: `tooling/fixtures/${k}.jsonl`, promptFiles: c.prompts, requiredJson: c.contract, notes: c.note, default: buildDefault[k] ? "有" : "无（必须人工撰写）" }])) }, null, 2));
  process.exit(0);
}

refreshClassification();

if (mode === "--anchors") {
  console.log(JSON.stringify({
    promptsDir: PROMPTS_DIR,
    anchorCounts: Object.fromEntries([...ANCHORS].map(([cap, list]) => [cap, list.length])),
    examples: Object.fromEntries([...ANCHORS].map(([cap, list]) => [cap, process.argv[3] === "--full" ? list : list.slice(0, 1)])),
    problems: ANCHOR_PROBLEMS,
  }, null, 2));
  process.exit(0);
}

if (mode === "--lint") {
  // --lint runs the app's own copy guards (they are the reason an authored summary can silently vanish).
  // Resolved through variables so the stub still lints when packages/backend is mid-edit.
  const vocabularySpec = "../packages/backend/src/editorial/vocabulary.ts";
  const writingSpec = "../packages/backend/src/editorial/writing.ts";
  let normalizeTags: ((v: unknown, o?: Record<string, unknown>) => string[]) | null = null;
  let finalizeCopy: ((input: Record<string, unknown>, copy: { titleZh: string; summaryZh: string }) => { titleZh: string; summaryZh: string; identityGuard: { outcome: string; unsupportedTitleEntityIds: string[]; unsupportedSummaryEntityIds: string[] } }) | null = null;
  try {
    normalizeTags = (await import(vocabularySpec)).normalizeTags;
    finalizeCopy = (await import(writingSpec)).finalizeCopy;
  } catch (error) {
    console.warn(`[brain] --lint 没能加载 apps 自身的词表/守卫（跳过这两项检查）：${String(error).slice(0, 160)}`);
  }
  const report: Array<Record<string, unknown>> = [];
  let bad = 0;
  for (const cap of [...new Set([...Object.keys(CAPS), ...fixtureCapabilities()])]) {
    const file = readFixtureFile(cap);
    if (!CAPS[cap]) { bad++; report.push({ cap, error: `没有 ${cap} 这个能力（fixture 文件名拼错？能力清单见 --schema）`, lines: file.lines.length }); continue; }
    for (const fixture of file.lines) {
      const problems: string[] = [];
      const notes: string[] = [];
      if (fixture.capability && fixture.capability !== cap) problems.push(`capability 字段 ${fixture.capability} 与文件名 ${cap} 不一致`);
      if (!fixture.author) notes.push("没有 author 署名");
      const ctx: Ctx = { system: "", user: "", hay: "", titles: [], urls: [], pass: 1, warnings: [] };
      let built: Record<string, unknown> | null = null;
      try {
        built = buildReply[cap]!({ ...fixture.reply }, ctx);
        if (cap === "prefilter" && !PREFILTER_LABELS.includes(String(built.label))) problems.push("label 非法");
        if (cap === "scores") {
          const n = Number(built.attentionScore);
          if (!Number.isInteger(n) || n < 0 || n > 100) problems.push("attentionScore 必须是 0-100 整数");
          if (fixture.reply.scoreSecond !== undefined) {
            const s = Number(fixture.reply.scoreSecond);
            if (!Number.isInteger(s) || s < 0 || s > 100) problems.push("scoreSecond 必须是 0-100 整数");
          }
        }
        if (cap === "understand" && !String(built.titleZh).trim()) problems.push("titleZh 不能为空（调用方 min(1) 会失败）");
        if (cap === "understand" && !String(built.summaryZh).trim()) problems.push("summaryZh 不能为空");
        if (cap === "understand" && String(built.summaryZh).length > 200) notes.push("summaryZh 超过 200 字，finalizeCopy 会压缩");
        if (cap === "digest" && String(built.digest).trim().length < 10) problems.push("digest 至少 10 字");
        if (cap === "report_period" && (!Array.isArray(built.themes) || built.themes.length < 1)) problems.push("themes 至少 1 个");
        if (cap === "translate_body" || cap === "translate_post") {
          if (fixture.reply.t === undefined && fixture.reply.segmentMap === undefined) problems.push("需要 t 或 segmentMap");
        }
        if (cap !== "summarize" && Object.keys(built).length === 0) problems.push("reply 是空对象");
        for (const w of ctx.warnings) notes.push(w);
      } catch (error) {
        problems.push(String(error));
      }
      // 词表和守卫用调用方自己的函数跑：normalizeTags 会静默丢弃不认识的标签，enforceIdentity 会丢掉
      // 提到“原文里没出现过的机构”的摘要。这两件事发生在真实管道里，所以在这里先撞一次。
      if (built && normalizeTags && (cap === "understand" || cap === "structure")) {
        const authored = Array.isArray(fixture.reply.tags) ? (fixture.reply.tags as unknown[]) : [];
        const kept = normalizeTags(authored);
        if (authored.length && kept.length !== authored.length) notes.push(`标签会被词表过滤/合并：${authored.join("、")} → ${kept.join("、")}`);
        if (authored.length && kept[0] !== authored[0]) notes.push(`第一个标签必须是分类标签（词表里的写法），当前会被换成「${kept[0]}」`);
      }
      if (built && finalizeCopy && fixture.guard && (cap === "understand" || cap === "summarize")) {
        const copy = { titleZh: String(built.titleZh ?? ""), summaryZh: String(built.summaryZh ?? "") };
        const guarded = finalizeCopy(
          { title: fixture.guard.title ?? "", text: fixture.guard.text ?? "", sourceKind: fixture.guard.sourceKind ?? "rss", sourceName: fixture.guard.sourceName, documentUrl: fixture.guard.url },
          copy,
        );
        if (guarded.identityGuard.outcome === "fallback") {
          problems.push(`身份守卫会退回：标题丢 ${guarded.identityGuard.unsupportedTitleEntityIds.join("/")}，摘要丢 ${guarded.identityGuard.unsupportedSummaryEntityIds.join("/")} —— 中文稿里的机构写法必须和原文一致（原文写 USGS 就写 USGS，不要写“美国地质调查局”）`);
        }
        if (guarded.summaryZh && guarded.summaryZh !== copy.summaryZh) notes.push("摘要超过 answer-first 规则，会被压缩");
      }
      if (problems.length) bad++;
      report.push({ cap, id: fixture.id, author: fixture.author ?? null, problems, notes });
    }
    if (file.errors.length) { bad += file.errors.length; report.push({ cap, readErrors: file.errors }); }
  }
  console.log(JSON.stringify({ vocabulary: VOCAB, anchorProblems: ANCHOR_PROBLEMS, fixturesWithProblems: bad, report }, null, 2));
  process.exit(bad ? 1 : 0);
}

if (!existsSync(PROMPTS_DIR)) {
  console.warn(`[brain] 找不到 ${PROMPTS_DIR}：所有能力只能靠内置 marker 识别（会把 via 标成 markers:*）。请检查 tooling/ 的位置。`);
}
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[brain] GEOHOT 编辑大脑 stub http://127.0.0.1:${PORT}/v1  (fixtures: ${FIXTURES_DIR})`);
  console.log(`[brain] 能力 ${Object.keys(CAPS).length} 个，锚点 ${[...ANCHORS.values()].reduce((n, a) => n + a.length, 0)} 条，词表 categories=[${VOCAB.categories.join(",")}] itemTypes=[${VOCAB.itemTypes.join(",")}]`);
  for (const problem of ANCHOR_PROBLEMS) console.warn(`[brain] ⚠ ${problem}`);
  for (const cap of Object.keys(CAPS)) {
    const file = readFixtureFile(cap);
    if (file.errors.length) console.warn(`[brain] ⚠ ${cap}.jsonl 有 ${file.errors.length} 行读失败：${file.errors.map((e) => `L${e.line} ${e.error}`).join("; ")}`);
  }
  console.log(`[brain] 审计：curl http://127.0.0.1:${PORT}/__brain/log ｜ 自检：GET /healthz`);
});

// Prompt files are authored by another agent and can change while this runs: reload the fingerprints and
// the fixtures when they do, so appending a fixture never needs a restart.
let lastReload = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  if (now - lastReload < 5_000) return;
  lastReload = now;
  const before = anchorSignature();
  refreshClassification();
  if (anchorSignature() !== before) console.log("[brain] 提示词锚点已更新");
  for (const cap of Object.keys(CAPS)) {
    const file = readFixtureFile(cap);
    if (file.errors.length) console.warn(`[brain] ⚠ ${cap}.jsonl L${file.errors[0]!.line}: ${file.errors[0]!.error}`);
  }
}, 5_000);
timer.unref?.();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[brain] ${signal}：关闭`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  });
}
