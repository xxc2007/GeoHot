// Tag normalization over the industry pack's vocabulary (industry/taxonomy.ts), which the topics
// (industry/topics.json) are built on.
import { CATEGORIES, CATEGORY_TAGS, ENTITY_TAGS, TAG_SYNONYMS, TOPIC_TAGS } from "@aihot/industry/taxonomy";

export { CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, TOPIC_TAGS } from "@aihot/industry/taxonomy";

const ALLOWED_TAGS = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);

/**
 * The pack's own catch-all tag. `industry/taxonomy.ts` documents the last CATEGORY_TAGS entry as exactly
 * that (「最后一个『其他』是兜底，顺序不要动：vocabulary.ts:24 取它作默认值」) and
 * `tests/industry-vocabulary.test.ts` pins that the last one is 「其他」, so this reads the declared
 * fallback instead of an accident of ordering: the alternative — a real category picked by position —
 * would put a content-type chip on an item that contradicts the section it is filed under.
 */
const CATCH_ALL_CATEGORY: string | null = CATEGORY_TAGS.length > 0 ? CATEGORY_TAGS[CATEGORY_TAGS.length - 1]! : null;

/**
 * Known tags only, synonyms mapped, duplicates dropped, at most `max`; the category tag goes first. A list
 * without one gets `fallbackCategory` (deterministic, no repair call), then the pack's catch-all; a pack
 * with no category tags at all gets the tags the answer actually carried, none invented.
 */
export function normalizeTags(v: unknown, opts: { max?: number; fallbackCategory?: string } = {}): string[] {
  const max = opts.max ?? 6;
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，]/g) : [];
  const tags: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().replace(/^#/, "");
    const tag = TAG_SYNONYMS[t] ?? TAG_SYNONYMS[t.toLowerCase()] ?? t;
    if (tag && ALLOWED_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  const isCategory = (t: string) => (CATEGORY_TAGS as readonly string[]).includes(t);
  const categoryIndex = tags.findIndex(isCategory);
  const category = categoryIndex >= 0 ? tags[categoryIndex]! : (opts.fallbackCategory ?? CATCH_ALL_CATEGORY);
  if (category === undefined || category === null) return tags.slice(0, max);
  return [category, ...tags.filter((t) => t !== category)].slice(0, max);
}

/** The category guide the structure step reads: one line per category. */
export const CATEGORY_GUIDE = CATEGORIES.map((c) => `- ${c.key}（${c.label}）：${c.guide}`).join("\n");
