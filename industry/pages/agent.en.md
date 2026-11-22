# Agent access guide

| 项 | 值 |
|---|---|
| 版本 | 2.0.0 (MCP and REST API v1, tracked in the site changelog) |
| 生效日期 | 2026-11-22 — this page describes the interfaces as they run today |

页首说明：

> GEOHOT gives agents direct, anonymous read-only access to its public content: MCP, RSS and REST API v1 all serve the same selected set — there is no separate, richer copy for machines. Titles and summaries are written in Chinese from public sources; treat them as reference material and verify important figures against the original links. This page is the English companion of the `/agent` page and `/llms.txt`.

## Connect through MCP

One URL lets an MCP client call the site directly: `https://<site>/api/mcp` (remote Streamable HTTP). It is not a web page — a browser opening it gets a 405. Anonymous and read-only, no token; tools return concise text plus the same structured data. The server answers `tools/list` with these 7 read-only tools:

- `geohot_get_latest`: curated picks, or everything, from the past 24 hours or the last 7 days
- `geohot_search`: search the last 7 days for companies, products, people or topics
- `geohot_get_hot_topics`: the current trending board and event ranking
- `geohot_get_story`: one trending event's timeline and its continuously updated summary
- `geohot_get_daily`: the latest daily brief, or the one for a given date
- `geohot_get_weekly`: the latest weekly brief, or the one for a given ISO week (the week's news arranged in sections)
- `geohot_get_monthly`: the latest monthly brief, or the one for a given month (arranged in sections the same way)

Boundaries: plain queries return at most 30 items, trending at most 10, an event timeline at most 50; out-of-range input is answered with a clear error, never silently widened. A `geohot_get_story` public_id comes only from event links returned by the trending tools — never guess an ID.

## Subscribe with RSS

RSS 2.0 feeds work with mainstream readers and automation tools:

- `/feed.xml` — the selected digest: the latest 50 selected digests, keeping titles, on-site reading and the path to the original
- `/feed/full.xml` — the same 50 digests; body text is inlined only for sources that explicitly allow redistribution
- `/feed/all.xml` — public updates from the past 7 days, newest first by actual publish time
- `/feed/daily.xml` — the daily brief, published at 08:00 Beijing time each day; the latest 30 issues are kept
- `/feed/category/{slug}.xml` and `/feed/full/category/{slug}.xml` — per-category feeds; slugs are the site's category keys

Conditional requests with ETag are supported and unchanged feeds answer 304; poll every 30 minutes or slower. An item's link points to the on-site reading page; the third-party original sits in `description`.

## REST API v1

Anonymous GET, no token; browsers via CORS, curl and default HTTP SDKs all work. The OpenAPI 3.1 definition at `/openapi-v1.json` is the source of truth for fields and error codes. Endpoints:

- `/api/v1/items` — selected items or everything from the past 7 days; filter by category, time and keyword
- `/api/v1/hot-topics` — the current trending board and event ranking
- `/api/v1/stories/{publicId}` — event detail: report timeline, summary and related events
- `/api/v1/dailies`, `/api/v1/dailies/latest`, `/api/v1/dailies/{date}` — the daily brief, by date
- `/api/v1/selected/snapshot` — the full current selected set; first complete sync (paginated)
- `/api/v1/selected/changes` — additions, edits and removals among the selected; afterwards fetch changes only

Omitting `mode` on `/api/v1/items` means `selected`; use `all` only when you truly need every public update. `items` carries no body text. To maintain the full selected set, take one snapshot, page with `nextPage` while `hasMore` is true, then send the cursor back unchanged to `changes`; save a new cursor only after each page has been fully applied.

Errors are Problem JSON. `400` invalid parameters, `409 snapshot_required` (take a fresh snapshot), `429` (honor `Retry-After`), `5xx` (back off exponentially and keep the last successful cache). Attach the `requestId` when reporting an error.

页脚：GEOHOT agent access guide — MCP, RSS and REST API v1 are anonymous and read-only; report issues on the feedback page at `/feedback`.
