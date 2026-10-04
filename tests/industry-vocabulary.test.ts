// The D3 class of defect: a tag written into a prompt that the code does not accept is dropped in silence,
// so a category or topic the editor believes exists never reaches a page. `.brief/vocab-validator.mts`
// checked this as a scratch script (47 assertions); this file is that check, moved into the suite so the
// drift is caught on every run instead of whenever someone remembers to invoke a script that lives outside
// the repository. Nothing here imports a scratch path: the prompts, the taxonomy and the fixtures are read
// from their real places under the repo root. The four checks the first migration of it dropped (the prompt's
// itemType list, its type→tag self-check line, structure's category keys and labels, the category guide) are
// restored below, so the suite covers what the script covered.
//
// What is pinned, in one line each: the whitelists the two writing prompts advertise are the vocabulary
// `normalizeTags` actually admits, character for character; the itemType → fallback-category table holds
// tag strings rather than category keys; the synonym table only points at real tags and shadows none; the
// hand-written judgements in `tooling/fixtures/*.jsonl` survive normalization unchanged; and every
// non-institutional topic page in `industry/topics.json` is reachable by a tag the runtime can emit.
//
// Deliberately not imported: `editorial/analyze.ts` (it opens a database connection). This check needs
// only the vocabulary and the prompt-rendering path, so it runs even without a migrated test database.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, CATEGORIES, ENTITIES, ENTITY_TAGS, ITEM_TYPES, TAG_SYNONYMS, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { CATEGORY_GUIDE, normalizeTags } from "@aihot/backend/editorial/vocabulary";
import { promptText } from "@aihot/backend/editorial/prompts";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

/** The same set vocabulary.ts builds from the pack's three lists. */
const ALLOWED = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);
const read = (f: string) => readFileSync(new URL(`../industry/prompts/${f}`, import.meta.url), "utf8");
/** Would the runtime keep this tag, or drop it in silence? */
const survives = (t: string) => normalizeTags([t]).includes(t);

/**
 * How analyze.ts:144-151 builds the structure step's system message — the whitelist there is injected by
 * code, so a drift between the file on disk and the constants can only appear in the rendered text.
 */
const structureRendered = promptText("structure", {
  categoryCount: String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
});
const understandRendered = promptText("understand");
const understandSource = read("content-understanding.md");
const structureSource = read("structure.md");

/** 取「……选一个：A、B、C。」式清单里的标签。 */
function tagsAfter(text: string, marker: string, terminator: RegExp): string[] {
  const at = text.indexOf(marker);
  if (at < 0) return [];
  const rest = text.slice(at + marker.length);
  const stop = rest.search(terminator);
  return (stop < 0 ? rest : rest.slice(0, stop)).split("、").map((s) => s.trim()).filter(Boolean);
}
/** 取「- 主题：A、B、C」一行的标签。 */
function listAfterLine(text: string, prefix: string): string[] {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).split("、").map((s) => s.trim()).filter(Boolean) : [];
}

const CATEGORY_MARKER = "第一个必须从以下分类标签中选一个：";

test("the three whitelists the content-understanding prompt advertises are exactly the tags normalizeTags admits", () => {
  const lists: Array<[string, string[]]> = [
    ["分类标签", tagsAfter(understandSource, CATEGORY_MARKER, /。/)],
    ["主题标签", listAfterLine(understandSource, "- 主题：")],
    ["实体标签", listAfterLine(understandSource, "- 实体：")],
  ];
  for (const [label, list] of lists) {
    assert.ok(list.length > 0, `${label} 从提示词里抽取到 ${list.length} 个 — 提示词的写法变了，这个检查要跟着改`);
    assert.deepEqual(list.filter((t) => !survives(t)), [], `content-understanding 的${label}全部要在 ALLOWED_TAGS 内`);
  }
  // Verbatim, including the 、 separator and any Latin spacing: a reworded list is a different list.
  assert.equal(tagsAfter(understandSource, CATEGORY_MARKER, /。/).join("、"), CATEGORY_TAGS.join("、"), "content-understanding 分类标签逐字等于 CATEGORY_TAGS");
  assert.equal(listAfterLine(understandSource, "- 主题：").join("、"), TOPIC_TAGS.join("、"), "content-understanding 主题标签逐字等于 TOPIC_TAGS");
  assert.equal(listAfterLine(understandSource, "- 实体：").join("、"), ENTITY_TAGS.join("、"), "content-understanding 实体标签逐字等于 ENTITY_TAGS");
  // The rendered system message the model is actually sent carries the same three lists in full.
  assert.ok(understandRendered.includes(CATEGORY_TAGS.join("、")), "渲染出的 understand 含完整分类标签");
  assert.ok(understandRendered.includes(TOPIC_TAGS.join("、")), "渲染出的 understand 含完整主题标签");
  assert.ok(understandRendered.includes(ENTITY_TAGS.join("、")), "渲染出的 understand 含完整实体标签");
  assert.equal(understandRendered.includes("{{"), false, "understand 渲染结果不遗留占位符");
});

test("structure.md injects its whitelist from the taxonomy, so it cannot drift from the code that reads it", () => {
  assert.ok(structureSource.includes("{{categoryTags}}"), "structure.md 仍用 {{categoryTags}} 注入分类白名单");
  assert.ok(structureSource.includes("{{topicTags}}"), "structure.md 仍用 {{topicTags}} 注入主题白名单");
  assert.ok(structureSource.includes("{{entityTags}}"), "structure.md 仍用 {{entityTags}} 注入实体白名单");
  assert.equal(tagsAfter(structureRendered, CATEGORY_MARKER, /。/).join("、"), CATEGORY_TAGS.join("、"), "structure 渲染出的分类白名单逐字等于 CATEGORY_TAGS");
  assert.equal(listAfterLine(structureRendered, "- 主题：").join("、"), TOPIC_TAGS.join("、"), "structure 渲染出的主题白名单逐字等于 TOPIC_TAGS");
  assert.equal(listAfterLine(structureRendered, "- 实体：").join("、"), ENTITY_TAGS.join("、"), "structure 渲染出的实体白名单逐字等于 ENTITY_TAGS");
  assert.deepEqual(listAfterLine(structureRendered, "- 主题：").filter((t) => !survives(t)), [], "structure 的主题白名单全部被放行");
  assert.equal(structureRendered.includes("{{"), false, "structure 渲染结果不遗留占位符");
});

test(`the content types and the ${CATEGORIES.length} categories the prompts name are the taxonomy's, verbatim`, () => {
  // The four checks the scratch validator ran here and the migration left out. A prompt that names a type or
  // a category the pack does not have is the same D3 defect as a bad tag: the model is told to answer with a
  // value nothing can store, and the item lands in the catch-all with no error anywhere.
  const typeSection = understandSource.slice(understandSource.indexOf("## 内容类型"), understandSource.indexOf("## 作者角色"));
  const promptItemTypes = [...typeSection.matchAll(/^- `([a-z_]+)`：/gm)].map((m) => m[1]!);
  assert.deepEqual(promptItemTypes, [...ITEM_TYPES], `content-understanding 的 itemType 清单必须逐字等于 ITEM_TYPES（含顺序）：${promptItemTypes.join("|")}`);
  // The prompt's own self-check line maps every type to its fallback category tag; that map is the table.
  const pairs = [...understandSource.matchAll(/`([a-z_]+)` 对应“([^”]+)”/g)];
  assert.equal(pairs.length, ITEM_TYPES.length, "自洽检查行覆盖全部 itemType");
  for (const [, type, tag] of pairs) assert.equal(CATEGORY_BY_ITEM_TYPE[type!], tag, `自洽行 ${type} → ${tag} 与 CATEGORY_BY_ITEM_TYPE 不一致`);
  // structure.md names the category keys and the Chinese labels the reader sees on the category pages.
  const keyLine = structureSource.split(/\r?\n/).find((l) => l.startsWith("一、类别 category"));
  assert.ok(keyLine, "structure.md 仍有「一、类别 category」这一行");
  const promptCats = tagsAfter(keyLine!, "只能输出这些 key：", /）/).join("、").split("/").map((s) => s.trim().split(/\s+/));
  assert.deepEqual(promptCats.map((m) => m[0]), CATEGORIES.map((c) => c.key), "structure 的类别 key 逐字等于 CATEGORIES");
  assert.deepEqual(promptCats.map((m) => m[1]), CATEGORIES.map((c) => c.label), "structure 的类别中文名逐字等于 CATEGORIES.label");
  // The guide the structure step is actually sent is built from the pack, so it cannot name a section no item has.
  for (const c of CATEGORIES) assert.ok(structureRendered.includes(`- ${c.key}（${c.label}）`), `类别指引缺 ${c.key}`);
  assert.ok(structureRendered.includes(CATEGORY_GUIDE), "渲染出的 structure 含完整 CATEGORY_GUIDE");
  // Keys are DB text values, API/MCP enum members and RSS URL slugs (`/feed/category/geotech.xml` is matched
  // case-sensitively, nothing lowercases it), so they stay plain ASCII with no delimiter that would break the
  // line above or a URL. Labels are the site's voice: pure Chinese noun phrases, no English, no emoji — and no
  // space, 「/」 or 「、」, the three characters the parser of that key line splits on.
  const keys = CATEGORIES.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "类别 key 不重复");
  for (const c of CATEGORIES) {
    assert.match(c.key, /^[A-Za-z][A-Za-z0-9]{1,29}$/, `类别 key ${c.key} 必须是 2–30 位的 ASCII 字母数字（它进网址、enum 和库）`);
    assert.match(c.label, /^[\u4e00-\u9fff]{2,7}$/, `类别 label「${c.label}」必须是二到七字的中文词组`);
  }
});

test("the worked example inside the prompt is itself a valid answer", () => {
  const exampleLine = understandSource.split(/\r?\n/).find((l) => l.startsWith('{"itemType"'));
  assert.ok(exampleLine, "content-understanding.md still carries its example judgement line starting with {\"itemType\"");
  const exampleTags = JSON.parse(exampleLine!).tags as string[];
  assert.ok(exampleTags.length > 0, "the example carries tags");
  for (const t of exampleTags) assert.ok(ALLOWED.has(t), `示例标签 ${t} 不在词表内`);
  assert.deepEqual(normalizeTags(exampleTags), exampleTags, "示例 tags 经 normalizeTags 原样保留（分类标签在前）");
});

test("ENTITY_TAGS is the entity roster's displayTag list, in order", () => {
  const displayTags = Object.values(ENTITIES).map((e) => e.displayTag).filter((t): t is string => !!t);
  assert.deepEqual(ENTITY_TAGS, displayTags, `ENTITY_TAGS(${ENTITY_TAGS.length}) 与 ENTITIES displayTag 序列完全一致`);
  assert.equal(new Set(displayTags).size, displayTags.length, "没有两个机构共用一个实体标签");
  // structure's subjects id table must cover the roster, or the model is told to invent ids.
  for (const id of Object.keys(ENTITIES)) assert.ok(structureRendered.includes(`${id}（`), `structure 的 subjects 表覆盖实体 ${id}`);
});

test("CATEGORY_BY_ITEM_TYPE holds tag strings, not category keys — the difference decides topic pages", () => {
  assert.deepEqual(Object.keys(CATEGORY_BY_ITEM_TYPE).slice().sort(), [...ITEM_TYPES].slice().sort(), "CATEGORY_BY_ITEM_TYPE 覆盖全部 ITEM_TYPES");
  for (const [type, value] of Object.entries(CATEGORY_BY_ITEM_TYPE)) {
    assert.ok((CATEGORY_TAGS as readonly string[]).includes(value), `${type} 的兜底值 ${value} 必须是 CATEGORY_TAGS 里的标签串`);
    assert.equal((CATEGORY_KEYS as readonly string[]).includes(value), false, `${type} 的兜底值不能是类别 key（vocabulary 会把它当标签插到第一位，主题页收不到）`);
  }
  assert.equal(CATEGORY_TAGS.at(-1), "其他", "CATEGORY_TAGS 末位是「其他」（无兜底时 vocabulary 写的默认值）");
  for (const type of ITEM_TYPES) {
    const res = normalizeTags([], { fallbackCategory: CATEGORY_BY_ITEM_TYPE[type] });
    assert.equal(res.length, 1, `${type} 兜底只剩一个分类标签`);
    assert.ok(ALLOWED.has(res[0]!), `${type} 兜底 → ${res[0]} 被放行`);
  }
});

test("the synonym table maps onto real tags and never shadows a canonical one", () => {
  for (const [from, to] of Object.entries(TAG_SYNONYMS)) {
    assert.ok(ALLOWED.has(to), `近义词 ${from} 指向的 ${to} 不在词表内`);
    assert.equal(to === from || !ALLOWED.has(from), true, `近义词键 ${from} 遮蔽了正牌标签`);
    assert.ok(normalizeTags([from]).includes(to), `近义词 ${from} 没有归一到 ${to}（实际 ${normalizeTags([from]).join("、") || "整条丢弃"}）`);
  }
  assert.ok(Object.keys(TAG_SYNONYMS).length > 0, "近义词表非空");
});

test("the hand-written judgements in the fixture corpus survive normalization untouched", () => {
  // These are the answers the local editorial-brain stub serves; a tag dropped here is a tag no reader sees.
  const seen: string[] = [];
  for (const f of ["understand.jsonl", "structure.jsonl"]) {
    const url = new URL(`../tooling/fixtures/${f}`, import.meta.url);
    assert.ok(existsSync(url), `语料 ${f} 存在`);
    // The corpus files carry a header comment line of their own, which is not a judgement.
    for (const line of readFileSync(url, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("//"))) {
      const parsed = JSON.parse(line) as { reply?: { tags?: unknown; subjects?: unknown } };
      const reply = parsed.reply ?? {};
      for (const t of Array.isArray(reply.tags) ? reply.tags : []) {
        seen.push(String(t));
        assert.equal(survives(String(t)), true, `${f} 的标签 ${t} 会被 normalizeTags 丢弃`);
        assert.equal(Object.hasOwn(TAG_SYNONYMS, String(t)), false, `${f} 的标签 ${t} 走的是近义词表，应改成正牌写法`);
      }
      for (const s of Array.isArray(reply.subjects) ? reply.subjects : []) {
        assert.ok(Object.hasOwn(ENTITIES, String(s)), `${f} 的 subject ${s} 不是 ENTITIES 的 id`);
      }
    }
  }
  assert.ok(seen.length > 100, `fixture 标签样本量 ${seen.length}`);
});

test("every tag a topic page matches on is one the runtime can emit", () => {
  const topics = (JSON.parse(readFileSync(new URL("../industry/topics.json", import.meta.url), "utf8")) as { topics: Array<{ slug: string; entityId?: string; tags: string[] }> }).topics;
  assert.ok(topics.length > 0, "topics.json 有主题");
  const unreachable = new Set<string>();
  for (const t of topics) {
    // topics.ts:62 — a topic with an entityId is filled by `entity:<id>` alone; its tags are never matched.
    if (t.entityId) {
      assert.ok(Object.hasOwn(ENTITIES, t.entityId), `主题 ${t.slug} 的 entityId ${t.entityId} 不在 ENTITIES 里，主题页永远空`);
      continue;
    }
    for (const tag of t.tags) if (!ALLOWED.has(tag)) unreachable.add(`${t.slug}:${tag}`);
  }
  assert.deepEqual([...unreachable], [], "非机构主题的标签必须全部在词表内，否则主题页永远收不到条目");
  // The daily paper's section order is derived from the pack, so it can never name a section no item has.
  const sections = [...new Set(CATEGORIES.map((c) => c.section))];
  assert.ok(sections.length >= 2, `日报分节 = ${sections.join(" / ")}`);
  for (const c of CATEGORIES) assert.ok(sections.includes(c.section), `类别 ${c.key} 的分节 ${c.section} 在分节顺序里`);
  // Upstream compose.ts:168 reads one hardcoded industry section name. It is inert here only because no
  // geography category carries that label; if a future retune ever names a section that, the metric line
  // reappears with the wrong contents — this assertion is the tripwire.
  const UPSTREAM_SECTION: string = "模型发布/更新";
  assert.equal(CATEGORIES.some((c) => c.label === UPSTREAM_SECTION || c.section === UPSTREAM_SECTION), false,
    `没有任何地理类别叫「${UPSTREAM_SECTION}」，所以 compose.ts 那行读到的恒为 0（日报少一行指标，不会显示错数）`);
});
