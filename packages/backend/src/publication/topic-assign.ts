/**
 * 主题归类。
 *
 * 以前主题页的判据是「条目的标签恰好撞上主题的标签」——43 个主题只认识 52 个具体标签，
 * 而 57% 的条目带的是「非地理/通用」「评论/解读」这类粗标签或者没有标签，于是它们永远进不了任何主题页。
 *
 * 现在改成一次显式分配：标签撞上、分类撞上、关键词出现，三条任一命中就落一行
 * `publication_topics`。主题页、主题计数、新鲜度审计都读这张表，判据只有一处。
 */
import { sql } from "../db.ts";
import { listTopics, type TopicRow } from "./topics.ts";

export interface TopicCandidate {
  title: string;
  summary: string | null;
  category: string | null;
  tags: string[];
}

export interface TopicMatch {
  slug: string;
  source: "tags" | "category" | "keyword";
}

/** 与 `topics.ts` 的 `topicMatchTags` 同口径：机构主题吃 `entity:<id>` 加机构名写法，其余吃自己的标签。 */
function tagKeys(t: TopicRow): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`, ...(t.org_names ?? [])] : t.tags;
}

const norm = (value: string | null | undefined) => (value ?? "").toLowerCase();

/**
 * 一条条目属于哪些主题。纯函数，方便测试与复算：
 * 同样的输入与同样的一张主题表，永远得到同样的一组 slug。
 */
export function topicsFor(input: TopicCandidate, topics: TopicRow[]): TopicMatch[] {
  const tags = new Set(input.tags.map((t) => t.toLowerCase()));
  const haystack = `${norm(input.title)}\n${norm(input.summary)}`;
  const category = norm(input.category);
  const out = new Map<string, TopicMatch>();

  for (const t of topics) {
    const keys = tagKeys(t).map((k) => k.toLowerCase());
    if (keys.some((k) => tags.has(k))) {
      out.set(t.slug, { slug: t.slug, source: "tags" });
      continue;
    }
    // 分类是分析链路给出的粗分类（geopolitics / human / nature…）。主题把它写进 tags 或 keywords
    // 就是在说"这一类归我"——用同一个匹配面，不额外发明一列。
    if (category && (keys.includes(category) || t.keywords.some((k) => k.toLowerCase() === category))) {
      out.set(t.slug, { slug: t.slug, source: "category" });
      continue;
    }
    const keyword = t.keywords.find((k) => {
      const needle = k.toLowerCase().trim();
      return needle.length >= 2 && haystack.includes(needle);
    });
    if (keyword) out.set(t.slug, { slug: t.slug, source: "keyword" });
  }
  return [...out.values()];
}

export interface AssignResult {
  scanned: number;
  assigned: number;
  rows: number;
}

/**
 * 复算一段时间的分配结果。
 *
 * 只做「这段时间内有变动的条目」，按 500 条一批：先删掉这批的旧分配，再写新的——
 * 一条条目换了标题或摘要之后，旧关键词不该继续把它挂在原来的主题上。
 */
export async function assignTopics(opts: { days?: number; now?: Date } = {}): Promise<AssignResult> {
  const days = opts.days ?? 3;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86400_000);
  const topics = await listTopics();
  if (topics.length === 0) return { scanned: 0, assigned: 0, rows: 0 };

  const rows = await sql<{ article_id: string; title: string; summary: string | null; category: string | null; tags: string[] }[]>`
    SELECT article_id, title, summary, category, tags
      FROM publications
     WHERE discovered_at >= ${since}
     ORDER BY discovered_at DESC`;
  const batch = 500;
  let assigned = 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const ids = slice.map((r) => r.article_id);
    const matches = slice.map((r) => ({ id: r.article_id, hits: topicsFor(r, topics) }));
    written += await sql.begin(async (tx) => {
      await tx`DELETE FROM publication_topics WHERE article_id IN ${tx(ids)}`;
      const flat: Array<{ id: string; slug: string; source: string }> = [];
      for (const m of matches) for (const h of m.hits) flat.push({ id: m.id, slug: h.slug, source: h.source });
      if (flat.length === 0) return 0;
      await tx`INSERT INTO publication_topics ${tx(flat.map((f) => ({ article_id: f.id, slug: f.slug, source: f.source })))}
               ON CONFLICT (article_id, slug) DO NOTHING`;
      return flat.length;
    });
    assigned += matches.filter((m) => m.hits.length > 0).length;
  }
  return { scanned: rows.length, assigned, rows: written };
}

/** 定时任务用：把结果写成一行日志，运维能看到覆盖率的趋势。 */
export async function assignTopicsAndReport(days: number): Promise<AssignResult> {
  const result = await assignTopics({ days });
  const [coverage] = await sql<{ total: number; covered: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM publication_topics pt WHERE pt.article_id = p.article_id))::int AS covered
      FROM publications p
     WHERE p.discovered_at >= now() - ${`${days} days`}::interval AND p.visibility = 'public'`;
  console.log(JSON.stringify({
    level: "info",
    msg: "topic assignment",
    days,
    ...result,
    coverage: coverage ?? { total: 0, covered: 0 },
  }));
  return result;
}