# Terms of Use

| 项 | 值 |
|---|---|
| 版本 | 2.0.40 (numbered with the site changelog) |
| 生效日期 | The site has run publicly as described on this page since 2026-10-01 |
| 运营主体 | Maintainer Xiong Xinchen (individually operated) |
| 备案号 | To be filled in once the maintainer's filing application is approved |

**Status**: the site has been running publicly since 2026-10-01. This revision syncs to the current facts: the contact and feedback channels are the email address (xxc200707@qq.com) and the feedback page, and the curated subscription runs over RSS, API and MCP. It changes no licensing terms and no reader rights or obligations.

页首说明：

> GEOHOT is an aggregation of digests and a reading index: it automatically watches the public sources of station networks, satellite and surveying agencies, statistics and planning departments, geography journals and researchers; it pre-screens against criteria written by the editors, then scores each item twice and independently; Chinese titles and summaries are model-written from the public sources, and the maintainer spot-checks and corrects them; reports of the same occurrence from many outlets are merged into one event; and a daily brief comes out every morning. The site only digests and paraphrases — it never reproduces the full original texts — and every entry keeps a link to the original. The website, RSS, public API and MCP are all usable anonymously; no registration is required.

## Status of this document (the site is live)

These terms are written the way this site actually runs — they are not a generic template: the behaviors described in sections 1, 2 and 3 can be checked directly. The site has been running publicly as described on this page since 2026-10-01, operated by its maintainer Xiong Xinchen (individually operated); the filing details and the jurisdiction for disputes are not yet confirmed by the maintainer, and items written in the body as "to be filled in by the maintainer" take no effect until they are filled in. The hazard and warning safety statement in section 3 and the copyright boundary in section 1 are operating premises of this site — not wording that can be loosened.

## 1. Content and copyright: digests and paraphrase only

- The Chinese titles, summaries, selection notes and event reviews you see on the site are model-written from public sources; the daily brief is assembled by background jobs under fixed rules, and the maintainer spot-checks, corrects and adjusts the content. They are **digests and paraphrase, not the full original texts**, and they do not stand for the original sources' positions.
- Rights to the originals' titles, texts, images, data and videos belong to the station networks, agencies, journals, media and authors that published them. Attributing the source is not a claim of any right over that content.
- Every entry carries a **link to the original**: on the item page the button says "打开原文" ("Open the original"; shortened to "原文" on the mobile top bar — the address after "来源：" ("Source:") at the end of the text is the same one), and `links.original` in the RSS and public API responses points to the same address. There is no interstitial page between the on-site reading view and the original, and no redirect advertising.
- The site does **not republish full original texts** unless a source is explicitly registered as allowing on-site full-text display (the `site_fulltext` permission flag in the source record, off by default). Without that permission, a source gets a digest plus the entry point to the original only. The full-text RSS (`/feed/full.xml`) works the same way: it inlines bodies only for sources that allow redistribution (`syndicate_fulltext`, off by default).
- The licensing scope of WeChat official-account articles, paywalled content, images and datasets does not become displayable here just because it is "technically reachable". For surveying products, administrative-division data and satellite imagery, the publishing agency's license terms prevail; the site only notes their existence and points to where they are published.

## 2. Automatically applied rules and human-set judgment tables can be wrong

- The site **uses third-party large-model services** (selected by the current model-pool configuration) for its daily screening and writing. Judgment enters at four steps: which category an item belongs to, the Chinese title and summary, merging reports from several outlets into one event, and scoring by spatial salience. The pipeline runs automatically: pre-screen → two independent scores under the same criteria → merge into events → the daily brief at 08:00. **The criteria are human-set** (the category table, thresholds, prompts and source list live in the repo's `industry/` and are confirmed item by item by the maintainer), **the per-item conclusions come from the model**, so they **can be wrong**; the maintainer spot-checks and corrects them in the admin (a correction overwrites the model's conclusion), and readers can flag mistakes through Feedback. Source titles and bodies are sent as input to the chosen model service; your personal data is not included.
- Site content may therefore contain mistyped numbers (magnitude, hypocenter depth, areal rainfall, basin area, population, distance), confused place names and agency names, reversed chronology, forecasts taken as things that already happened, or one party's statement taken as a conclusion. Translations of terms from English sources may also be nonstandard.
- Treat this content as a **reading index and a set of leads**, not a quotable source of facts. Any number or conclusion destined for a paper, report, lesson plan, manuscript, government or engineering document must be checked against the link to the original, the original data or the official release, and cited to that original source — not to a page on this site.
- Entries keep the times they were generated and revised; important corrections are recorded in the entry and traced in the changelog (see section 8).

## 3. Safety statement for hazard and warning content

This site collects earthquake quick reports, typhoon tracks and storm surge, rainstorm flooding and drought, landslides and debris flows, cold waves and dust storms, and the warning and response bulletins of meteorological and emergency agencies. **None of this content is a basis for warnings.**

> For any decision made for safety — hazard preparedness, evacuation and relocation, travel and shipping, farming and construction schedules, opening of scenic areas and events, insurance claims — rely on the **current official release** from the China Earthquake Networks Center, meteorological stations at every level, hydrological and oceanographic forecast agencies, and the natural-resources and emergency-management departments. This site is not a warning-issuing agency, holds no statutory authority to issue warnings, and nothing on it may serve as a basis for warnings, liability disclaimers or decisions.

The reasons deserve to be spelled out, because they are limitations built into this site's pipeline:

- Summaries are secondhand retellings of official bulletins and lag behind them; the magnitude, depth and wind speed of a quick report get revised within the first hour, and an entry may still show the old values.
- Warnings carry severity levels, areas in effect and start and end times; compressing one into a short Chinese summary most easily loses exactly "where, and from when to when".
- An event page's review reflects the moment it was written; a disaster scene changes within hours.
- Collection is automatic, and model scoring runs automatically under editor-set criteria; neither can guarantee recognizing whether a bulletin has been withdrawn or superseded.
- Showing a warning here does not mean it is still in effect, nor that your location is inside its coverage.

Where it appears on item pages: an entry covered by this section repeats, in one small line under the Chinese summary (or under the title when there is no summary), the sentence "本站不是预警信息发布机构、本页内容不构成预警依据" ("This site is not a warning-issuing agency; nothing on this page is a basis for warnings"), linking back to this section. The trigger uses the entry's own category and tags — category "自然地理" ("physical geography"), or tags containing "预警/响应" ("warning/response") or "灾害事件" ("hazard event"). That line is only a pointer; the rule cannot cover every piece of hazard-related content: a review or research piece tagged only "台风" ("typhoon") and "区域地理" ("regional geography"), from a source that is not an official network, may not carry it. **The absence of the line does not mean this section does not apply** — it applies to everything on the site, with or without the line; whenever an official release and an on-site summary disagree, the official release prevails.

Unverified rumors never reach the selection; for claims like "this place will sink" or "this river will change course", the site's rule is to block them outright rather than flag them as doubtful. When an official release and an on-site summary disagree, the official release prevails — and please tell us under section 5 so we can correct it.

## 4. Linking and redistribution

- Always welcome: personal reading and study; citation in classroom teaching and research; sharing links to the site's item pages with others; quoting a sentence or two of an on-site summary in your own writing, credited to GEOHOT with the link to the original being quoted.
- Require the maintainer's prior written consent: using the site's summaries, scores, event merges or daily-brief content in commercial products, paid services, training datasets or LLM corpora; bulk crawling, whole-site mirroring, systematic redistribution; publishing content in the name of this site or an official agency in any form (including labeling an on-site summary as "issued by such-and-such network").
- The quotation permission the site gives you does not extend to the original itself. For full-text reuse, get authorization from the original source; the site has no power to license it for you, and it will not assert rights with the source on your behalf.
- Automated access must follow `/robots.txt`: `/api/v1/` and `/api/mcp` may be crawled; `/api/`, `/admin/`, `/starred` and `/feedback` may not. Responses carry ETag, `Cache-Control` and, for RSS, `ttl` (minutes) — poll with conditional requests (`If-None-Match`) at the pace those values describe, not with high-frequency full pulls.
- On a 429 or 503, wait as the response's `Retry-After` (seconds) says; do not retry in parallel after a timeout, and do not split one request across concurrent lanes. The search endpoint answers 503 directly when at capacity.

## 5. Complaints and corrections

Whether you are a source or a reader, reach us through the **feedback page** (`/feedback`, no login needed, anonymous is fine, one screenshot allowed). The site does not currently publish a contact email (`SITE.contactEmail` in `industry/site.ts` is empty), so `/.well-known/security.txt` returns 404; this route is registered under the `/geohot/` subpath, while scanners, per RFC 8615, actually fetch `/.well-known/security.txt` at the domain root (the territory of another site on the same domain), so even with an email filled in it would not appear where scanners look — whether to publish an email is the maintainer's operating decision, see section 9.

- **Sources, agencies and parties involved**: you may ask for factual corrections, removal of an entry, summary-only display without the body text, removal of the site from the crawl list, or a supplementary statement of your licensing scope. Attach the link to the original or the on-site item address.
- **Readers**: you may point out wrong numbers, text and image mismatches, wrong categories or merges, pre-revision values presented as current data, or obvious omissions of coverage from multiple sides. Attach the item address and the source you are relying on.
- For safety issues under section 3 (a summary that could mislead about a warning's validity, for example), start the feedback with "预警" ("warning") and we will handle it first.
- Handling: every piece of feedback has a status and a handling record in the admin, and every manual change there goes into the audit log; content found to be wrong is corrected in place with the correction note kept. **First reply and resolution deadlines: to be filled in by the maintainer** (this page promises no deadline on your behalf).
- Content is never taken down because you disagree with a conclusion; it is corrected or removed only when it is factually wrong or exceeds the licensing scope.

## 6. Public endpoints

The endpoints below are anonymous, read-only and need no API key; their output comes from the same selection as the web pages (one set of selected results — there is no "better for the API, worse for the reader" second set):

- RSS: selected digest `/feed.xml`, all updates `/feed/all.xml`, full-text `/feed/full.xml`, daily brief `/feed/daily.xml`, by category `/feed/category/{category}.xml`.
- Public API v1: `/api/v1/items`, `/api/v1/hot-topics`, `/api/v1/stories/{id}`, `/api/v1/dailies`; definitions in `/openapi-v1.json`.
- MCP: `/api/mcp` (remote Streamable HTTP), with seven read-only tools — `geohot_get_latest`, `geohot_search`, `geohot_get_hot_topics`, `geohot_get_story`, `geohot_get_daily`, `geohot_get_weekly`, `geohot_get_monthly` (whatever `tools/list` returns is authoritative).
- The agent-facing guide lives at `/agent` and `/llms.txt`.

Treat the endpoints as for reading and retrieval. To wire them into your own product or service, get consent under section 4 first; endpoint shapes may change, and we do not promise long-term compatibility for uses not listed on this page.

## 7. Disclaimers

- The site is provided "as is" and "as available", with no express or implied warranty of the accuracy, completeness, timeliness or fitness of its content.
- The warning safety statement in section 3 and section 2's "check important numbers against the original" are part of these disclaimers; registering, subscribing, paying or commercial use does not change them.
- Nothing here is legal, planning, investment, engineering, insurance or emergency-response advice. For rezoning, plan approvals, land expropriation and site selection, disaster loss assessment and the like, the competent authority's announcements, approvals and technical standards prevail.
- Links lead to third-party websites whose content the site does not control; a link is not an endorsement.
- The site is not liable for indirect losses from using or failing to use its content (missing a deadline, decisions made on wrong numbers, interrupted operations).
- For gaps, delays or outages caused by force majeure, upstream source changes or third-party service failures, the site will restore service in good faith, but it does not guarantee uninterrupted availability.

## 8. Change notices

- Every change to this page and to the privacy notice is recorded in the changelog (`/changelog`), and this page's version number is raised and its effective date updated at the same time.
- Major changes that affect your rights and obligations (data uses, complaint channels, disclaimers, licensing terms) are announced in advance in the changelog and on the home page before they take effect; **advance notice: to be filled in by the maintainer** (no fewer than 7 days is suggested).
- Breaking changes at the endpoint level (RSS, public API v1, MCP) are announced separately, with the retirement dates of the old versions noted.
- Continued use after a change takes effect counts as accepting the revised terms; if you do not agree, you may stop using the site.
- History: this page is kept as a file in the repository, and you can request the full text of the current effective version through the feedback page at any time.

## 9. Placeholders left for the maintainer

The items below must be confirmed and filled in by the maintainer in person; the site does not make them up on anyone's behalf:

- **Effective date and version number**: the version number follows the site changelog's 2.0.x numbering (see the table at the top); on the day a version is finalized, set the effective date (the "生效日期" row) to the real date.
- **ICP and public-security filings**: only the operator in person can apply for and fill them in (`SITE.icp` in `industry/site.ts`); until then the footer shows no filing number, and this page's table should not go live with its filing row left empty.
- **Contact email (published)**: `SITE.contactEmail` is now `xxc200707@qq.com`, and the contact lines in `/.well-known/security.txt` and `llms.txt` appear automatically. Note that this route sits under the `/geohot/` subpath while scanners, per RFC 8615, fetch the domain root — whether to point the root here at the deployment layer is the maintainer's call. The feedback-page channel in section 5 is unaffected by that decision and always available.
- **Governing law and dispute resolution**: this page deliberately names no jurisdiction or court of jurisdiction for now; the maintainer decides and adds them before launch. Foreign sources and overseas deployments read differently — have a professional review it when needed.
- **Hosting and operations**: who hosts the server and the domain, and how long logs are kept (the privacy notice's section 4 needs the same facts).
- **Complaint deadlines**: the reply and resolution deadlines left blank in section 5.
- **Commercial licensing**: whether, and on what terms, the consent-required uses in section 4 are accepted.
- **Attribution and branding**: the admin-login cookie and browser-local-storage key names still carry the upstream framework's prefix; changing them all to this site's brand means editing constants in `apps/` and `packages/`.
