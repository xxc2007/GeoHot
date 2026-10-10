// The other half of the archive: journals whose history is on their own site rather than in Crossref.
//
// Why this exists is measured: `scripts/backfill-archive.ts` reached the past through Crossref by ISSN, and
// `config.issn` is only allowed on `rss` sources — so the Chinese geography journal this pack collects as
// `web_list` was invisible to that door. The archive that built is 1,927 items and **not one of
// them is Chinese**, while the rest of the site is 55% Chinese. Crossref cannot fix that: of the eight ISSNs
// those journals print, six are not registered there, and one of the two that are belongs to another journal
// entirely (the count of record is `config-keys.ts:15`).
//
// 《地理研究》 is a Magtech CMS and publishes its own back-issue index (过刊浏览 at `/CN/archive_by_issues`).
// Measured 2026-10-10 against that live page: it lists 331 issues from 1982 to 2026, each as
// `<div class="gk_qi"><a href="…/CN/Y2026/V45/I1"><span>2026 Vol. 45 No. 1 pp. 1-281</span></a> 2026-01-10`,
// and one of those issue pages lists 18 article links. Both pages are listings of the shape the collector
// already reads — a container, one link inside it, a date beside it — so this route does not add a second HTML
// parser. It hands `fetchWebList` the source's own rules with only the page swapped:
//
//   * the index, as a list of issues: its own item selector, and the date beside each link;
//   * an issue page, with the source's live `itemSelector` and `allowUrlPrefixes` unchanged, because the same
//     CMS puts its articles in the same markup on the current TOC and on a 1998 issue.
//
// Two properties follow, and both are why the walk lives here rather than in the script:
//
//   1. The date is the one the index prints next to the issue. An issue the index does not date stays out:
//      writing its items under the crawl day would file a March issue in tonight's paper.
//   2. Which pages to read comes off the journal's own anchors. No issue URL is ever templated, so a journal
//      whose index moves or changes markup stops yielding material instead of inventing URLs.

import { setTimeout as delay } from "node:timers/promises";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { fetchWebList } from "./web-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

/** One issue, as the journal's own back-issue index names it. `at` is null when the index gives no date. */
export interface SiteIssue {
  url: string;
  at: Date | null;
}

/**
 * Read one listing page, once more after a short wait if the server itself failed.
 *
 * Measured 2026-10-10 from the collector box: 《地理学报》's index returned HTTP 500 inside
 * `backfill-archive.ts` and HTTP 200 with the same 204 KB body minutes later over the same crawler UA, and
 * 《地理研究》 itself answered 500 for a bare `curl/8` UA while answering 200 for two others — the Magtech
 * CMS is flaky on its own, in a way the request identity does not explain. A backfill walks one page per
 * issue, so a single transient 500 used to abandon a whole month slice into `pending` for a rerun; one retry
 * costs four seconds and usually reads the page. Anything past that is still the caller's "this slice did not
 * finish", unchanged.
 *
 * Only a 5xx is retried. "no items matched", a refused host and a missing URL are answers about the page, not
 * about the server's mood — repeating them doubles the requests and changes nothing.
 */
async function readList(source: SourceRow, overrides: Partial<SourceRow["config"]>) {
  const once = () => fetchWebList({ ...source, config: { ...source.config, ...overrides } });
  try {
    return await once();
  } catch (first) {
    if (!(first instanceof FetchError) || typeof first.status !== "number" || first.status < 500) throw first;
    await delay(4_000);
    try {
      return await once();
    } catch {
      throw first;
    }
  }
}

/** An archive rule the source must declare before its history can be walked. */
function archiveKey(source: SourceRow, key: string): string {
  const value = source.config[key];
  if (typeof value !== "string" || !value) throw new Error(`${source.id} 缺少 config.${key}`);
  return value;
}

/**
 * Every issue the back-issue index lists, each with the date printed beside its link, in the order the
 * journal presents them. Only the allow-list is rewritten, to the index's own origin: a back-issue page links
 * subscriptions and socials, and the issue walk must not leave the journal's site. A `denyUrlPrefixes` the
 * source declares still applies.
 */
export async function backIssues(source: SourceRow): Promise<SiteIssue[]> {
  const indexUrl = archiveKey(source, "archiveIndexUrl");
  const itemSelector = archiveKey(source, "archiveIssueItemSelector");
  const dateRegex = archiveKey(source, "archiveIssueDateRegex");
  const issues = await readList(source, { url: indexUrl, itemSelector, publishedAtRegex: dateRegex, allowUrlPrefixes: [`${new URL(indexUrl).origin}/`] });
  // An issue the index did not date comes back with `at: null` rather than being dropped: the caller counts
  // what it could not file, so a journal that stops printing its dates on the index shows up in the ledger
  // instead of quietly yielding less and less history.
  //
  // A dated issue is placed at the start of its own Beijing day. `dates.ts` reads a bare 2026-01-10 as UTC
  // midnight — right for a machine timestamp, wrong for a date a journal prints — and Beijing midnight is
  // exactly where a daily edition closes, so keeping the instant as read would put a January 10 issue in the
  // January **11** paper. `web-list.ts`'s `headingDate` faces the same problem for a changelog heading and
  // solves it differently — it appends ` 00:00` so the source's own `publishedAtUtcOffset` applies. Flooring
  // to Beijing is used here because an archive issue has to land in a Beijing edition whatever offset the
  // source declares: it is the paper's day that must match, not the publisher's clock.
  return issues.map((i) => ({ url: i.url, at: i.publishedAt ? beijingMidnight(beijingDate(i.publishedAt)) : null }));
}

/**
 * The articles one issue page lists, with this source's own live rules for what an article link looks like. An
 * article whose page carries no date of its own is filed under the issue's date — which is what a journal
 * issue means: the whole issue appears on that day. Every item therefore comes back dated, which is what
 * lets the caller drop its own fallback.
 */
export async function issueArticles(source: SourceRow, issue: SiteIssue & { at: Date }): Promise<Array<Candidate & { publishedAt: Date }>> {
  const items = await readList(source, { url: issue.url });
  return items.map((c) => ({ ...c, publishedAt: c.publishedAt ?? issue.at }));
}
