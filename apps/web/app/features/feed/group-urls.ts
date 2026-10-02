// The two lists a reading group expands into ("另有 N 家信源报道" / "展开 N 条进展") and the addresses
// they are fetched from. Both are root-absolute site paths, so each builder takes the deployment's
// publicPath(): behind a prefixing proxy the site answers on /geohot, and a bare /api/site/… request
// leaves this app entirely — it lands on whatever else lives on that domain root and comes back 404.
// No React and no `import.meta` here, so a test can pin the prefix on the produced address.
import type { TimelineFilters } from "@aihot/contracts/site";

/** The filters the list was drawn under, plus the page to continue from. */
export function groupQuery(filters: TimelineFilters | undefined, cursor: string | null): URLSearchParams {
  const sp = new URLSearchParams();
  if (filters?.channel && filters.channel !== "all") sp.set("channel", filters.channel);
  if (filters?.category) sp.set("category", filters.category);
  if (filters?.tag) sp.set("tag", filters.tag);
  if (cursor) sp.set("cursor", cursor);
  return sp;
}

/** The other public reports of one fact. */
export function groupReportsUrl(publicPath: (path: string) => string, factId: string, filters?: TimelineFilters, cursor: string | null = null): string {
  return publicPath(`/api/site/groups/${encodeURIComponent(factId)}/reports?${groupQuery(filters, cursor)}`);
}

/** The other developments of one event, newest first. */
export function storyDevelopmentsUrl(publicPath: (path: string) => string, storyPublicId: string, filters?: TimelineFilters, cursor: string | null = null): string {
  return publicPath(`/api/site/stories/${encodeURIComponent(storyPublicId)}/developments?${groupQuery(filters, cursor)}`);
}
