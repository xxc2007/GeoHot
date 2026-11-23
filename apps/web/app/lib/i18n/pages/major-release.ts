// 重大更新专题卡（features/changelog/MajorRelease.tsx）的英文文案。
//
// 中文卡片正文仍写在 MajorRelease.tsx 的分支函数里（中文页逐字不变）；这里放 /en 要替换的
// 标题、导语、章节与入口链接，键是 changelog.json 里那张卡的 dateTtime。卡片里的交互演示
// （Journey / PayloadComparison / ReplyJourney / LangDemo / major-later 的五块）按页面语言取词，
// 英文文案写在各组件自己的 EN 常量里（2026-11-23 起不再是一张中文演示配一句说明）。
import type { Locale } from "../../i18n.ts";

interface CardCopy {
  title: string;
  lead: string[];
  sections: Array<{ title: string; body: string }>;
  links: Array<[string, string]>;
}

const en: { chrome: { kicker: (version: string) => string; pinned: string }; cards: Record<string, CardCopy> } = {
  chrome: {
    kicker: (version) => `Major update · v${version} · pinned`,
    pinned: "Pinned",
  },
  cards: {
    "2026-11-22T18:05": {
      title: "The English interface is live — the site now switches between Chinese and English",
      lead: [
        "Geography news does not stop at one language. The site now has an English edition: navigation, buttons and page notes all switch to English, and on items from international agencies the English pages lead with the source's own headline and original body.",
        "The English edition was young at launch: AI summaries and briefs were still in Chinese then and said so on the page; coverage follows the changelog.",
      ],
      sections: [
        { title: "One switch, either language", body: "A language switch sits in the sidebar and on the More page; English pages live under the /en prefix, so the address you know plus /en opens them directly." },
        { title: "English pages read the original first", body: "International agencies publish in their own language: the English edition prefers the source's headline and original body, one paraphrase less. Items without an original title still show the edited title." },
        { title: "Chinese content was labelled honestly at launch", body: "At launch, AI summaries and briefs were written in Chinese; in the English edition they stayed Chinese and were marked as such. The interface was English; the content said which language it was in." },
        { title: "One dataset, two ways to read it", body: "The English and Chinese editions read the same public content: picks, updates, briefs, topics and the feedback entrance line up one to one, and switching language does not interrupt the page you are on." },
      ],
      links: [["Browse all updates", "/all"], ["Open the English home", "/en"], ["Read the changelog", "/changelog"]],
    },
    "2026-11-20T22:40": {
      title: "Every model call now has a ledger you can check",
      lead: [
        "This release turns model calls and back-office state into figures that can be reconciled: subscription, free, no-public-price and public API list prices are recorded separately; the price card is versioned, and each cooldown states how it recovers.",
        "The back office no longer hides slow queries behind a fake zero or an endless “generating”; old data stays, marked with when it was read.",
      ],
      sections: [
        { title: "Five price bases, each kept apart", body: "Public API list prices are estimates only; subscription, free, no-public-price and unverified calls are labelled separately. Upstream actuals come from receipts: an estimate is never written as actual, and a missing charge is never called free." },
        { title: "Versioned price card, daily FX check", body: "Forty-seven mappings are stored with the migration; each call is converted with the price card valid at that moment. The card is checked each morning; if a benchmark disappears or changes, it is marked for review and the last good price is kept instead of guessing." },
        { title: "Cooldown is not a ban", body: "Disabled accounts, daily quotas, per-minute limits, connection failures and missing configuration are handled separately, each with its own recovery time and condition. Receipts with unknown outcomes are not replayed blindly; one attempt is allowed after the window." },
        { title: "Slow back office, no pretending", body: "The runs page shows live heartbeats and queues first, with detailed stats filled in behind; the first usage report no longer caches “unavailable” for a minute. Reader memory and back-office assets are handled separately, and the reader side still comes first." },
      ],
      links: [["Open usage overview", "/admin/usage"], ["Open the model pool", "/admin/models"], ["Read the changelog", "/changelog"]],
    },
    "2026-11-20T22:30": {
      title: "Two thousand sources — when one breaks, another takes its place",
      lead: [
        "6.0 gave five machines their roles; this release turns the source pool into a ledger that balances itself: one thousand active sources, one thousand verified reserves, and a broken entrance no longer holds a slot forever.",
        "Reserves are public RSS and JSON endpoints only; verification is a read-only probe that writes no article and calls no model.",
      ],
      sections: [
        { title: "One thousand plus one thousand, not two thousand names", body: "The active pool keeps collecting; the reserve pool only holds candidates. The same address cannot sit in both. Old entrances no article cites leave the running pool; the archive does not pretend they are usable." },
        { title: "Every five minutes, at most four checks", body: "A reserve needs a title, a link and a valid date within the last four hundred days; only then does it read “reserve available”. Quarantined or archived candidates do not count." },
        { title: "Replace only on evidence", body: "An active source must fail at least five times in a row, for at least twenty-four hours, with a real attempt in the last six, before it can be replaced. Budget limits, rate limits and 429s do not trigger a swap." },
        { title: "A ceiling on how many swap", body: "At most two per round and twelve in a rolling twenty-four hours; if failed sources reach a tenth of the active pool, swapping stops for a human. Each swap stops one and starts one in the same transaction, and the failed source goes to quarantine." },
      ],
      links: [["Open the source pool", "/admin/sources"], ["Read the changelog", "/changelog"], ["About this site", "/about"]],
    },
    "2026-11-15T13:00": {
      title: "Five machines, one pipeline",
      lead: [
        "5.0 solved “fast”; this release solves “fast all the time”: the main database serves readers only, four workers take roles, run quietly by day and wider at night, and come back on their own when they fail.",
        "The back-office Servers page shows CPU, memory, disk, unit state and heartbeat for every machine at once, and keeps a place for one that is offline.",
      ],
      sections: [
        { title: "Roles, each minding its own queue", body: "The coordinator registers collection and scheduled jobs; workers take analysis and extraction only; image fetching has its own lane. Each role registers only the queues it should take." },
        { title: "Day/night window and disk pressure", body: "Analysis widens at 23:00 and closes at 07:00; past the IO threshold no new slots are added, and any 5xx on the reader side steps back at once." },
        { title: "The gate stops new work, never kills running work", body: "Repeated reader-side 5xx no longer restarts processes; it only freezes new claims. 5xx during a deploy window does not count, so the site does not judge itself broken." },
        { title: "Self-healing written into the units", body: "Tunnel restarts are unlimited, worker failures retry, keepalive uses its own session; backups and deploys wait for a quiet disk before they start." },
      ],
      links: [["Check server status", "/admin/server"], ["About this site", "/about"], ["Read the changelog", "/changelog"]],
    },
    "2026-11-15T12:50": {
      title: "Milliseconds: readers see it first, machines calculate later",
      lead: [
        "4.0 made content wait until every gate cleared, and the price was readers waiting while the back office filled the disk. This release moves the wait off the reader: five cache layers, pages kept warm by timers, and a Guangzhou edge for readers in China.",
        "Same minute, same route: 2.10 s from Cloudflare to origin abroad, 0.11 s at the Chinese edge, 0.0003 s on a cache hit.",
      ],
      sections: [
        { title: "Five cache layers, each closer", body: "nginx stale pages, on-disk drafts of the pool and timeline, in-process source caches, the edge reverse proxy, and the browser cache: a hit at any layer avoids the database." },
        { title: "Timers walk the pages before readers do", body: "The home page and All updates are warmed every fifty seconds, so the 120-second cache is always a step ahead of expiry; the edge adds its own warmth on top." },
        { title: "An edge in China, the primary abroad", body: "The Guangzhou machine reverse-proxies to the primary: it serves from cache and never opens the database. After a release, the edge follows within two minutes." },
        { title: "Yielding on a slow disk", body: "Back-office processes drop to idle disk priority; backups use ionice and skip the two largest tables; past IO 60 the analysis slots are taken back." },
      ],
      links: [["Browse all updates", "/all"], ["See the trending board", "/hot"], ["Read the changelog", "/changelog"]],
    },
    "2026-11-15T12:40": {
      title: "What is in today's news is readable today",
      lead: [
        "3.0 turned reading into a conversation; these two weeks brought the lens back to the content: a report passes source licence, full body, Chinese copy, relevance and the release gate before a reader sees it.",
        "Once the gates were complete, what could be read on one day went from 12 items back to 40; phones and desktop no longer ask for “next page” — keep scrolling.",
      ],
      sections: [
        { title: "Five gates; miss one and it does not ship", body: "Fetching, extraction, translation, scoring and publication each have their own criteria; anything short stops halfway, and the page only shows content that walked the whole line." },
        { title: "Backfill is no longer blocked by a hidden condition", body: "A backfill row said “selected” but had no release time; the gate read an empty value and neither let it through nor rejected it — 248 items stalled for a day. They are now written and backfilled." },
        { title: "Keep scrolling; no next page", body: "Picks, All updates, topic pages and the back-office lists all continue on scroll; pagination links remain only for readers without scripts." },
        { title: "When data is late, show the previous copy, not an error", body: "The collection pool and the timeline each keep an on-disk draft; when a cache expires, the previous copy goes out first and the new one swaps in behind." },
      ],
      links: [["Browse all updates", "/all"], ["Read the daily brief", "/daily"], ["Read the changelog", "/changelog"]],
    },
    "2026-10-24T07:30": {
      title: "Turning the world's geographic change into threads you can read each day",
      lead: [
        "Since launch, GEOHOT has connected geographic sources, organised Chinese copy, and joined single reports into events and daily briefs. This release puts those changes together and reintroduces the site.",
        "It keeps improving around geographic reading. What is written here has shipped; historical coverage and translation progress are stated on the pages themselves.",
      ],
      sections: [
        { title: "Geography is the main line", body: "Physical, human, regional, political, historical, frontier geography and GIS — seven categories to find your field. Important reports try to state place, time, reach and source." },
        { title: "Long foreign articles read on", body: "The reading page keeps the original entrance and offers a Chinese summary and full translation. Long translations continue in sections; scientific numbers, units and original order are protected, and unfinished work says so." },
        { title: "Follow today, look back at the past", body: "All updates browse by date; event pages gather reports from several sides; daily, weekly and monthly briefs offer another way back. Historical imports and backfills restore processing; old content keeps its own date." },
        { title: "Feedback and integration entrances", body: "Local saves keep your place; feedback accepts screenshots and reaches the editor. MCP, RSS and the REST API offer anonymous read-only access to readers, agents and your own programs." },
      ],
      links: [["Browse all updates", "/all"], ["Read the daily brief", "/daily"], ["Integrate your agent", "/agent"]],
    },
    "2026-11-01T23:59": {
      title: "From reading to a reply: the site now closes the reader-service loop",
      lead: [
        "2.0 joined geographic reports into readable threads; this month we extended reading into conversation: every feedback reaches the editor's mailbox, its progress can be checked at any time, and the reply comes back to your inbox. Contact channels are now the mailbox and the feedback page alone.",
        "More than forty updates this month; this card picks the main line. The full list is in the timeline below, each with a version number.",
      ],
      sections: [
        { title: "Feedback straight through, progress visible", body: "Text and screenshots submitted on the feedback page go straight to the editor's mailbox; failures retry for a week. Leave an email and you can check progress; the reply from the back office carries your address, so replying continues the conversation." },
        { title: "One channel, one story", body: "Contact email, security contact file, privacy note and terms speak the same way; picks are subscribed through RSS, API and MCP, with no extra push channel." },
        { title: "Easier to read, more of it visible", body: "Daily, weekly and monthly brief titles are all clickable, images open in a viewer; an item whose source allows only a summary still has a landing page with title, digest and original entrance — no more 404." },
        { title: "A stronger back office", body: "Body extraction runs several paths in parallel and leaves a trace; the model pool grows to a dozen gates and is checked against official prices daily; when the server is tight, auxiliary work yields and reader pages come first." },
      ],
      links: [["Send feedback", "/feedback"], ["Check progress", "/feedback"], ["Read the changelog", "/changelog"]],
    },
    "2026-10-01T22:40": {
      title: "GEOHOT is live: a reading site built for geography",
      lead: [
        "GEOHOT grew from a general framework into a geography site of its own: sources became station networks, satellites and survey agencies, statistics and planning departments, geography journals and researchers' public channels; selection was rewritten around spatial impact and evidence; Chinese titles and summaries, event grouping and the morning brief were rebuilt for geography.",
        "The website, RSS, public API and MCP are anonymous and need no account.",
      ],
      sections: [
        { title: "Sources: geography only", body: "Official bulletins for earthquakes, typhoons and floods; authoritative population and boundary figures; the latest geography journal research; long reads by people doing regional studies and fieldwork. The fastest sources are checked every 30 minutes, most every one to four hours." },
        { title: "Selection: spatial salience and evidence", body: "First, is it geography, and does it carry real information? Then two spatial-salience scores; only their sum clearing the threshold gets in. Travel advertorials, study-tour recruiting and scenic-area press releases stay out — the editors wrote the standard." },
        { title: "The brief: out at 08:00 every day", body: "Items are ordered by heat and keep their original address so you can check them; several reports of one quake or one dataset become one event, and the trending board is computed from those." },
        { title: "Public: one dataset, consistent everywhere", body: "Website, RSS, public API and MCP read the same public content; the site writes summaries and paraphrase, never copies the full original — copyright stays with the stations, agencies, journals and media." },
      ],
      links: [["Browse all updates", "/all"], ["Read the daily brief", "/daily"], ["About this site", "/about"]],
    },
  },
};

/** 中文页不使用这本字典（中文卡片仍在 MajorRelease.tsx 里），所以 zh 返回 null，避免误用。 */
export function majorReleaseCopy(locale: Locale) {
  return locale === "en" ? en : null;
}

export type { CardCopy };