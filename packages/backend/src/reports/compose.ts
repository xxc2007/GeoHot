// Daily, weekly and monthly reports. Windows are Beijing calendar based and written into the report;
// missed schedule points are caught up; regeneration creates a revision. The editors' prompts are in
// the industry pack (industry/prompts/report-*.md), the sections follow its categories.
//
// Nothing here publishes prose nobody wrote. The lead, the headline and the overview are the paper speaking
// to the reader — editorial judgement, so they follow the rule `editorial/provenance.ts` states and
// `events/digest.ts` applies: an answer the stub assembled from a capability default (no fixture, no author)
// is refused, and the edition keeps the honest shape it would have had with no writer at all (no lead, no
// 大标题, stories filed under the paper's own sections). Which is not a rarer case than it sounds: as of
// 2026-10-05 the production database had four report calls in it, all four machine defaults, and nine of
// its eleven dailies already published with `lead: null`. The refusal is recorded on the edition
// (`generator.leadRule` / `generator.proseRule`) and on the receipt, so the surfaces waiting for a
// signature are listable rather than guessed at.
import { z } from "zod";
import { SITE } from "@aihot/industry/site";
import { CATEGORIES, RELEASE_CATEGORY_KEY } from "@aihot/industry/taxonomy";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { modelFor } from "../editorial/models.ts";
import { machineRuleOf } from "../editorial/provenance.ts";
import { guardedStoryTitle, looksZh, type TranslateInput } from "../editorial/writing.ts";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange } from "@aihot/contracts/time";
import { sql, type Tx } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { chineseCopyCondition } from "../publication/items.ts";

export const REPORT_VERSION = promptVersion("report-daily-lead", "report-period");

const SECTION_OF: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.section]));
const SECTION_ORDER = [...new Set(CATEGORIES.map((c) => c.section))];
/**
 * Where an item without a category goes. It used to be "the last section", which was harmless while
 * every section had a category: after 2026-10-03 deleted 野外与考察 and 观点与解读 the last section
 * became 技术, so a 碳排放解读 with no category was printed under a heading that expands to
 * 「地理信息系统」 and counted as a data release. A bucket that belongs to no category says what it is.
 */
const DEFAULT_SECTION = "未归类";
/** The sections the paper prints: the vocabulary pack's order, then the bucket for uncategorised items. */
const REPORT_SECTIONS = [...SECTION_ORDER, DEFAULT_SECTION];
/** How many of the day's entries the lead writer is shown. Longer editions are introduced by their real size. */
const LEAD_BRIEF_LIMIT = 30;

export interface ReportEntry {
  itemId: string;
  factId: string | null;
  storyPublicId: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  firstParty: boolean;
  role: string;
  score: number | null;
  publishedAt: string;
}

export interface Candidate extends ReportEntry {
  category: string | null;
  factKey: string;
}

function roleOf(kind: string, firstParty: boolean): string {
  if (firstParty) return kind === "x_search" ? "X·官方" : "官方";
  if (kind === "x_search") return "X·KOL";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

export async function candidates(start: Date, end: Date): Promise<Candidate[]> {
  const rows = await sql.begin("isolation level read committed", async (tx) => {
    // Wait for in-flight releases and keep later ones outside this snapshot. The following SELECT
    // gets a fresh READ COMMITTED snapshot; model calls and report writes happen after the lock ends.
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    return tx<{
      id: string; title: string; summary: string | null; url: string; category: string | null; score: number | null; first_party: boolean;
      source_id: string; source_name: string; source_kind: string; fact_public_id: string | null; story_public_id: string | null; at: Date; backfill: boolean;
    }[]>`
      SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.score, p.first_party, s.id AS source_id, s.name AS source_name,
             s.kind AS source_kind, f.public_id AS fact_public_id, st.public_id::text AS story_public_id, p.timeline_at AS at, p.backfill
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN facts f ON f.id = p.fact_id LEFT JOIN stories st ON st.id = f.story_id
      -- Attribute each item by the later of arrival and release; either range can use its index.
      -- 报纸是中文的：门槛用读取层那一条（items.chineseCopyCondition），不在这儿再抄一遍正则——
      -- 列表和版面必须说同一句话，两份写法早晚不一致。
      WHERE p.visibility = 'public' AND p.selected AND NOT p.backfill AND ${chineseCopyCondition()}
        AND (
          (p.visible_after <= p.timeline_at AND p.timeline_at >= ${start} AND p.timeline_at < ${end})
          OR (p.visible_after > p.timeline_at AND p.visible_after >= ${start} AND p.visible_after < ${end})
        )`;
  });
  // One entry per fact: first-party first, then score.
  const byFact = new Map<string, Candidate>();
  for (const r of rows) {
    const key = r.fact_public_id ?? `a:${r.id}`;
    const c: Candidate = {
      itemId: r.id, factId: r.fact_public_id, storyPublicId: r.story_public_id, title: r.title, summary: r.summary ?? "",
      sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party, role: roleOf(r.source_kind, r.first_party),
      score: r.score === null ? null : Number(r.score), publishedAt: r.at.toISOString(), category: r.category, factKey: key,
    };
    const prev = byFact.get(key);
    if (!prev || Number(c.firstParty) - Number(prev.firstParty) > 0 || (c.firstParty === prev.firstParty && (c.score ?? 0) > (prev.score ?? 0))) byFact.set(key, c);
  }
  // Score, then the item's own moment, then its id. Sorting by score alone leaves ties in whatever order
  // the row scan happened to return (this SELECT has no ORDER BY), and these entries are handed to the
  // lead and period writers as a numbered list whose positions the editors' fixtures quote by number: an
  // unreproducible order means a rerun of the same issue can number the same story 26 or 27.
  return [...byFact.values()].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) || a.publishedAt.localeCompare(b.publishedAt) || a.itemId.localeCompare(b.itemId));
}

/** Facts and items already covered by recent editions are not repeated. */
async function recentlyCovered(kind: "daily", before: string, days = 7): Promise<Set<string>> {
  const rows = await sql<{ content: Record<string, any> }[]>`
    SELECT content FROM reports WHERE kind = ${kind} AND key < ${before} AND key >= ${addDays(before, -days)}`;
  const out = new Set<string>();
  for (const r of rows) {
    for (const s of r.content.sections ?? []) for (const it of s.items ?? []) {
      if (it.itemId) out.add(`a:${it.itemId}`);
      if (it.factId) out.add(it.factId);
      if (it.clusterId) out.add(`c:${it.clusterId}`);
    }
  }
  return out;
}

const LeadSchema = z.object({
  title: z.string().max(120).catch(""),
  leadParagraph: z.string().max(600).catch(""),
  highlights: z.array(z.union([z.number(), z.string()])).max(6).catch([]),
});

/** What an edition is written from: the entries it cites. A headline may only name what they name. */
function entriesIdentity(entries: ReportEntry[]): TranslateInput {
  return {
    title: entries.map((e) => e.title).join("\n"),
    text: entries.map((e) => `${e.sourceName}｜${e.title}｜${e.summary.slice(0, 220)}`).join("\n"),
    sourceKind: "rss",
  };
}

/** A period issue's prose, judged the same way: an empty theme list is an answer the composer can act on. */
function unusablePeriod(d: { overview: string; themes: Array<{ heading: string; summary: string }> }): string | null {
  return !looksZh(d.overview) || !d.themes.every((t) => looksZh(t.heading) && looksZh(t.summary)) ? "总述或主题不是可用的中文" : null;
}

/**
 * Whether this answer has anything to print, in one place asked two ways: the writer keeps the edition
 * without a lead, and `chatJson` refuses the receipt — so an English or empty 导语 is not handed back to us
 * for free on every later run of this issue (see providers/llm.ts `usable`).
 */
function unusableLead(d: { title: string; leadParagraph: string }): string | null {
  return !d.title.trim() || !d.leadParagraph.trim() || !looksZh(d.title) || !looksZh(d.leadParagraph) ? "标题或导语不是可用的中文" : null;
}

/**
 * The day's 导语, or `refused` with the reason. `highlights` go with it: which three stories lead an edition
 * is the same kind of editorial judgement, and the read layer already has a rule of its own for an edition
 * without one (the three highest-scoring items), so refusing costs no layout — it only declines to print a
 * choice nobody made.
 */
async function writeLead(kind: string, key: string, entries: ReportEntry[], model: string) {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, LEAD_BRIEF_LIMIT);
  const list = shown.map((e, i) => `${i + 1}. ${e.title}｜${e.summary.slice(0, 120)}`).join("\n");
  // The brief is capped, the edition is not. Say which is which, or a lead that repeats the length of
  // what it was handed states a number this issue does not carry (the front page prints the real one).
  const brief = shown.length === entries.length ? list : `本期共 ${entries.length} 条入选动态，下列分数最高的 ${shown.length} 条：\n${list}`;
  const res = await chatJson({
    model, purpose: "report_lead", subject: `report:${kind}:${key}`, promptVersion: REPORT_VERSION,
    system: promptText("report-daily-lead"),
    user: brief, schema: LeadSchema, temperature: 0.3, maxTokens: 800,
    usable: unusableLead,
  });
  const title = res.data.title.trim();
  const leadParagraph = res.data.leadParagraph.trim();
  const rule = machineRuleOf(res.usage);
  // The 导语标题 is the daily's own headline — it goes into the RSS item title, the OG card and the v1
  // `leadTitle`. The weekly has been guarded against naming an institution its entries never named since
  // the identity-guard round; the daily was the one reader-visible headline left unguarded, so the same
  // candidate printed a claim here that a weekly would refuse. A refused title takes the lead with it:
  // a lead paragraph nobody can vouch for is not printed under a headline nobody wrote.
  const guarded = guardedStoryTitle(title, entriesIdentity(shown));
  const refused = rule ?? (unusableLead(res.data) ? "no-signed-copy" : null) ?? (guarded === null ? "headline-identity-guard" : null);
  const highlights = refused
    ? []
    : res.data.highlights
      .map((h) => entries[Number(h) - 1])
      .filter((e): e is ReportEntry => !!e)
      .map((e) => e.itemId);
  return { lead: refused ? null : { title: guarded ?? "", leadParagraph }, highlights, receiptId: res.receiptId, refused };
}

/**
 * Does this issue carry what the reader gate counts as content? The shapes mirror `citedItemIds`
 * (publication/reports.ts) exactly: daily sections[].items, periodic themes[].storyRefs. A blank issue
 * — no citations — never consumes a 期号 (`reports.issue_no`), so the printed series skips it the way
 * the archive already does. And a story that never made the page (a flash) is not content for this test
 * either, because the gate does not count it.
 */
function issueCarriesCitations(kind: "daily" | "weekly" | "monthly", content: Record<string, unknown>): boolean {
  const groups = (kind === "daily" ? content.sections : content.themes) as Array<Record<string, any>> | undefined;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => (((kind === "daily" ? g?.items : g?.storyRefs) ?? []) as unknown[]).length > 0);
}

/**
 * The next number in this kind's series, or null when the issue arrives late. Serialized per kind so
 * two composes cannot both take N + 1. "Late" is a day that failed to compose and only gets written
 * after a later-dated issue already holds a number (the catch-up path): the series counts in key
 * order — migration 0048 numbered existing rows that way — so a straggler must not print an older
 * date under a higher number. It stays readable and dated, just unnumbered.
 */
async function nextIssueNo(tx: Tx, kind: string, key: string): Promise<number | null> {
  // The lock comes first. Read "is there a later numbered issue?" before taking it and a catch-up run
  // (older key) racing a scheduled run (newer key) can both see "no later issue" — the older one then
  // stamps the higher number, which is exactly the ordering this function exists to protect.
  await tx`SELECT pg_advisory_xact_lock(hashtext('report-issue-no:' || ${kind}))`;
  const [later] = await tx`SELECT 1 AS x FROM reports WHERE kind = ${kind} AND issue_no IS NOT NULL AND key > ${key} LIMIT 1`;
  if (later) return null;
  const [row] = await tx<{ n: number }[]>`SELECT coalesce(max(issue_no), 0) + 1 AS n FROM reports WHERE kind = ${kind}`;
  return row!.n;
}

async function saveReport(kind: "daily" | "weekly" | "monthly", key: string, start: Date, end: Date, content: Record<string, unknown>, reason: string, model: string) {
  await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: number; revision: number; content: unknown; generated_at: Date; issue_no: number | null }[]>`
      SELECT id, revision, content, generated_at, issue_no FROM reports WHERE kind = ${kind} AND key = ${key} FOR UPDATE`;
    if (existing) {
      await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at, reason)
               VALUES (${existing.id}, ${existing.revision}, ${tx.json(existing.content as never)}, ${existing.generated_at}, ${reason}) ON CONFLICT DO NOTHING`;
      // The number is stamped once and never moves: a recompose keeps it, and so does an issue that
      // later loses every citation (withdrawals do not renumber the rest of the series).
      const no = existing.issue_no ?? (issueCarriesCitations(kind, content) ? await nextIssueNo(tx, kind, key) : null);
      await tx`UPDATE reports SET content = ${tx.json(content as never)}, window_start = ${start}, window_end = ${end}, generated_at = now(),
                 model = ${model}, revision = revision + 1, origin = 'model', issue_no = ${no}, updated_at = now() WHERE id = ${existing.id}`;
    } else {
      const no = issueCarriesCitations(kind, content) ? await nextIssueNo(tx, kind, key) : null;
      await tx`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin, issue_no)
               VALUES (${kind}, ${key}, ${start}, ${end}, ${tx.json(content as never)}, now(), ${model}, 'model', ${no})`;
    }
  });
}

/** Daily report for Beijing date D covers [D-1 08:00, D 08:00) Beijing time. */
export async function composeDaily(date: string, reason = "scheduled"): Promise<{ key: string; entries: number }> {
  const end = new Date(beijingMidnight(date).getTime() + 8 * 3600 * 1000);
  const start = new Date(end.getTime() - 86400000);
  const covered = await recentlyCovered("daily", date);
  const all = await candidates(start, end);
  const fresh = all.filter((c) => !covered.has(c.factKey) && !covered.has(`a:${c.itemId}`));
  const perSection = new Map<string, Candidate[]>();
  const flashes: Array<{ itemId: string; title: string; sourceName: string; sourceUrl: string; publishedAt: string }> = [];
  for (const c of fresh) {
    const label = SECTION_OF[c.category ?? ""] ?? DEFAULT_SECTION;
    const list = perSection.get(label) ?? [];
    if (list.length < 8) list.push(c);
    else if (flashes.length < 12) flashes.push({ itemId: c.itemId, title: c.title, sourceName: c.sourceName, sourceUrl: c.sourceUrl, publishedAt: c.publishedAt });
    perSection.set(label, list);
  }
  const sections = REPORT_SECTIONS.filter((l) => perSection.get(l)?.length).map((label) => ({
    label,
    items: perSection.get(label)!.map(({ category: _c, factKey: _f, ...entry }) => entry),
  }));
  const ordered = sections.flatMap((s) => s.items).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const model = await modelFor("report");
  const lead = ordered.length ? await writeLead("daily", date, ordered, model) : null;
  const content = {
    date,
    lead: lead?.lead ?? null,
    highlights: lead?.highlights ?? [],
    sections,
    flashes,
    metrics: {
      totalEvents: ordered.length,
      sourcesCount: new Set(ordered.map((e) => e.sourceId)).size,
      // Counted over the candidates by their own category, never by the section they were filed under:
      // the bucket for uncategorised items is not a data release (`sections` above strips `category`).
      modelsReleased: [...perSection.values()].flat().filter((c) => c.category === RELEASE_CATEGORY_KEY).length,
      firstPartyEvents: ordered.filter((e) => e.firstParty).length,
    },
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    generator: { version: REPORT_VERSION, model, leadRule: lead?.refused ?? null, repeatsSuppressed: all.length - fresh.length },
  };
  await saveReport("daily", date, start, end, content, reason, model);
  if (lead) await completeReceipt(sql, lead.receiptId);
  return { key: date, entries: ordered.length };
}

export const PeriodSchema = z.object({
  // A headline is asked for, but a missing or unusable one leaves the issue on its generic name.
  headline: z.string().max(60).catch(""),
  overview: z.string().max(1500).catch(""),
  themes: z
    // A theme cites at most eight entries; a model that lists more keeps its first eight rather than failing the issue.
    // No `min(1)`: an edition whose prose nobody signed is filed under the paper's own sections instead (see
    // `sectionsOf` below), so "no themes" is an answer the composer can act on rather than a failed call.
    .array(z.object({ heading: z.string().max(60), summary: z.string().max(800), refs: z.array(z.union([z.number(), z.string()])).transform((refs) => refs.slice(0, 8)) }))
    .catch([])
    .transform((themes) => themes.slice(0, 6)),
});

/**
 * The theme list for an edition whose model prose was refused: the paper's own sections, in the reading
 * order it was going to print. Entries is not prose — the label comes from `CATEGORIES` in the industry
 * pack, the same buckets the daily already files under — and filing the week's stories by it loses the
 * reader nothing but the sentence.
 */
function sectionsOf(entries: Candidate[]): Array<{ heading: string; summary: string | null; storyRefs: ReportEntry[] }> {
  const bySection = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    const label = SECTION_OF[e.category ?? ""] ?? DEFAULT_SECTION;
    bySection.set(label, [...(bySection.get(label) ?? []), (({ category: _c, factKey: _f, ...entry }) => entry)(e)]);
  }
  return [...bySection.entries()].map(([heading, storyRefs]) => ({ heading, summary: null, storyRefs }));
}

/** The editor's brief for a week or month: its top entries as a numbered list, each with its section. */
export function periodPrompt(kind: "weekly" | "monthly", startDate: string, endDateInclusive: string, top: Candidate[]) {
  const list = top.map((e, i) => `${i + 1}. [${SECTION_OF[e.category ?? ""] ?? DEFAULT_SECTION}] ${e.title}｜${e.summary.slice(0, 140)}`).join("\n");
  return {
    system: promptText("report-period", { kindName: kind === "weekly" ? "周报" : "月报", overviewLength: kind === "weekly" ? "150–300" : "200–400" }),
    user: `本期：${startDate} 至 ${endDateInclusive}\n${list}`,
  };
}

async function composePeriod(kind: "weekly" | "monthly", key: string, startDate: string, endDateInclusive: string, reason: string) {
  const start = beijingMidnight(startDate);
  const end = beijingMidnight(addDays(endDateInclusive, 1));
  const all = await candidates(start, end);
  const top = all.slice(0, kind === "weekly" ? 40 : 60);
  const dailyCount = (await sql<{ n: number }[]>`SELECT count(*) AS n FROM reports WHERE kind = 'daily' AND key >= ${startDate} AND key <= ${endDateInclusive}`)[0]?.n ?? 0;
  let themes: Array<{ heading: string; summary: string | null; storyRefs: ReportEntry[] }> = [];
  let headline = "";
  let overview = "";
  let receiptId: number | null = null;
  let proseRule: string | null = null;
  const model = await modelFor("report");
  if (top.length) {
    const res = await chatJson({
      model, purpose: `report_${kind}`, subject: `report:${kind}:${key}`, promptVersion: REPORT_VERSION,
      ...periodPrompt(kind, startDate, endDateInclusive, top), schema: PeriodSchema, temperature: 0.3, maxTokens: 2500,
      usable: unusablePeriod,
    });
    receiptId = res.receiptId;
    const rule = machineRuleOf(res.usage);
    // One decision for the whole answer. An issue half published — its 总述 from a person, its 主题 from a
    // rule — is a thing nobody could vouch for, so `digest.ts` refuses that shape too.
    const signed = !rule && !unusablePeriod(res.data);
    if (signed) {
      overview = res.data.overview;
      themes = res.data.themes.map((t) => ({
        heading: t.heading,
        summary: t.summary,
        storyRefs: t.refs.map((r) => top[Number(r) - 1]).filter((e): e is Candidate => !!e).map(({ category: _c, factKey: _f, ...e }) => e),
      }));
      // The 大标题 names what the issue is about, which is the judgement the identity guard exists for: it
      // may only say what this issue's own entries say, or the issue keeps its generic name.
      headline = guardedStoryTitle(res.data.headline, entriesIdentity(top)) ?? "";
    } else {
      proseRule = rule ?? "no-signed-copy";
    }
    if (themes.length === 0) themes = sectionsOf(top);
  }
  const content = {
    kind,
    title: kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`,
    ...(kind === "weekly" ? { isoLabel: key } : { monthLabel: key }),
    periodStart: startDate,
    periodEnd: endDateInclusive,
    ...(headline ? { headline } : {}),
    ...(overview ? { overview } : {}),
    themes,
    storyOrder: top.map((e) => e.itemId),
    metrics: { totalStories: themes.reduce((n, t) => n + t.storyRefs.length, 0), selectedCount: all.length, reportsCovered: Number(dailyCount) },
    generator: { version: REPORT_VERSION, model, proseRule },
  };
  await saveReport(kind, key, start, end, content, reason, model);
  if (receiptId) await completeReceipt(sql, receiptId);
  return { key, entries: top.length };
}

export async function composeWeekly(label: string, reason = "scheduled") {
  const range = isoWeekRange(label);
  if (!range) throw new Error(`bad week label ${label}`);
  return composePeriod("weekly", label, range.start, range.end, reason);
}

export async function composeMonthly(label: string, reason = "scheduled") {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad month label ${label}`);
  const start = `${label}-01`;
  const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, "0")}-01`;
  return composePeriod("monthly", label, start, addDays(next, -1), reason);
}

/**
 * Catch-up: generates any missing daily report for the last `days` days (never the future and never
 * before the first report in the database), the last complete week and the last complete month.
 */
export async function catchUpReports(now = new Date(), days = 7): Promise<{ generated: string[] }> {
  const generated: string[] = [];
  const today = beijingDate(now);
  const bjHour = Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 13));
  const [first] = await sql<{ key: string | null }[]>`SELECT min(key) AS key FROM reports WHERE kind = 'daily'`;
  const latestDue = bjHour >= 8 ? today : addDays(today, -1);
  for (let i = days - 1; i >= 0; i--) {
    if (shutdownSignal.signal.aborted) return { generated }; // the next hourly run continues
    const d = addDays(latestDue, -i);
    if (first?.key && d < first.key) continue;
    // Catch-up never opens an edition whose window is still going: a daily for D gathers
    // [D-1 08:00, D 08:00) and closes at D 08:00, and an issue keyed ahead of the reader's clock would
    // reach the site as a paper that has not come out yet.
    if (Date.parse(`${d}T08:00:00+08:00`) > now.getTime()) continue;
    const [exists] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${d}`;
    if (!exists) {
      await composeDaily(d, "catch-up");
      generated.push(`daily:${d}`);
    }
  }
  // Last complete ISO week (Monday 10:00 onwards).
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const lastWeek = isoWeekLabel(addDays(today, -dow - 7));
  const weekDue = dow > 0 || bjHour >= 10;
  if (weekDue) {
    const [w] = await sql`SELECT 1 FROM reports WHERE kind = 'weekly' AND key = ${lastWeek}`;
    if (!w) {
      await composeWeekly(lastWeek, "catch-up");
      generated.push(`weekly:${lastWeek}`);
    }
  }
  // Last complete month (1st 10:30 onwards).
  const [y, mo, dd] = today.split("-").map(Number) as [number, number, number];
  const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  const monthDue = dd > 1 || bjHour > 10 || (bjHour === 10 && Number(new Date(now.getTime() + 8 * 3600000).toISOString().slice(14, 16)) >= 30);
  if (monthDue) {
    const [m] = await sql`SELECT 1 FROM reports WHERE kind = 'monthly' AND key = ${prevMonth}`;
    if (!m) {
      await composeMonthly(prevMonth, "catch-up");
      generated.push(`monthly:${prevMonth}`);
    }
  }
  return { generated };
}
