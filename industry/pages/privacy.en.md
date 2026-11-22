# Privacy Notice

| 项 | 值 |
|---|---|
| 版本 | 3.0.3 (numbered with the site changelog) |
| 生效日期 | This site has been running publicly, as described on this page, since 2026-10-01 |
| 运营主体 | Xiong Xinchen, site owner (individually operated) |

**Status**: This site has been running publicly since 2026-10-01. This revision brings the text up to date with current facts: feedback and contact channels have been consolidated into direct email to xxc200707@qq.com, the Feishu collaboration and Feishu sign-in channels have been retired, and the site no longer depends on Feishu in any way. The uses of reader data are unchanged.

页首说明：

> Reading GEOHOT requires no registration, no sign-in, and the site never sets any Cookie on you. We only process what is needed to keep the site working and to handle feedback you choose to submit; we do not sell or share personal information, and we run no third-party analytics or advertising tracking. Every statement below corresponds to what the site's code actually does.

## Status of this document (the site is running publicly)

This page describes what this software actually does in its current deployment, checked line by line against the code; the site has been serving readers the way this page describes since 2026-10-01. What the site owner still needs to fill in are the retention period of the hosting and reverse-proxy access logs, the applicable jurisdiction and the feedback retention period (see section 9); those placeholders stay open until they are filled in. Every other statement on this page describes behavior that is already running — not a pre-launch plan.

## 1. Public reading is anonymous

- Public pages, RSS, the public API v1 and MCP are all anonymous and read-only: no API key, and nothing recorded about who you are. The site has no reader account system — only an admin back office.
- Opening pages, paging, searching, reading the daily brief or opening an event page **submits no identity of yours to this site, and you receive no Cookie from this site**: the only flow on the whole site that writes a Cookie is back-office sign-in.
- After signing into the back office there is exactly one session identifier between the browser and the server; admins and readers see the same public content — there is no "admin-only view" of the public pages.

## 2. Browser-local data (stored on your own device)

The following are written only to your current browser's local storage and are **never sent to the server**: saved items, read markers, your light/dark theme preference, the sort choice of an event page's timeline, the "which changelog version you have seen" marker, and any feedback draft not yet submitted.

- They disappear when you clear your browser's data; they do not sync across devices or browsers; signing in or out does not affect them.
- You can export them to a file from the "Saved" page and import that file on another device — the only sync method this site provides.
- The storage key names follow the upstream framework's prefix (e.g. `aihot-starred-items`). That is a branding matter, not a privacy one; renaming them all to this site's prefix requires a code change, see section 9.
- Every inline script on a page is listed below (verified on both the dev preview and the production build: 7 scripts on the home page and item pages, 6 on pages without structured data, such as this one):
- **Theme bootstrapping** (1 script, the first line of `<head>`): reads `aihot-theme` from your device; when you have no stored preference it follows the system's light/dark setting, then writes the result to the `data-theme` attribute of `<html>` so the first paint does not flash. It only reads local storage and changes one attribute; it never touches the network.
- **Structured data** (1 script, `application/ld+json`): the site name, logo address and editorial name, or an item page's breadcrumb. This is data for search engines, not executable code — the browser does not run it, and it contains none of your information.
- **Scroll restoration** (1 script): records where you had scrolled to on this page in **the current tab's `sessionStorage`** (key `react-router-scroll-positions`, a framework prefix, see section 9), so returning to this page scrolls back to that spot. Written to this machine only, gone when the tab closes, never sent to the server.
- Besides scroll positions, the same `sessionStorage` holds two sets of the site's own **session-scoped** keys with the same character (local to this machine, gone when the tab closes, never sent to the server): `aihot:list:*` keeps a snapshot of where you left a list page (cards loaded, groups expanded or not, where the screen was) so that "back" restores it in place, kept for at most 30 minutes; `aihot:groups:` keeps the open/closed state of a card's group panel. Like the `aihot-*` local storage above, they carry the upstream prefix (see section 9).
- **Framework hydration** (4 scripts: page data, module entry and the closing of the data flow, one each): the server has already rendered this page as full HTML and handed it to you; these scripts give the same server-side content to the framework in your browser, so filters, paging and switching the interface language work. They read no Cookies, read none of your local storage, and request nothing from any third party; the only fetching is loading this site's own bundled scripts from its own `/assets/` (same origin). Hovering a filter button may prefetch that page's data once — again from this site only.
- Beyond these four kinds, **the site's own code produces no other JavaScript**. All JavaScript on the site is produced by this site's code and its framework and loaded same-origin; there are no inline third-party scripts.
- One thing is not in this site's code but is visible in your browser, so it is written down here: this site shares the domain `xxc2007.me` with the site owner's other site, and the domain is hosted on Cloudflare. **If Cloudflare's "Web Analytics" is enabled, it injects a statistics script from `static.cloudflareinsights.com` into the HTML it sends you** — it is not added by this site, and it is not in this site's code (fetching the same page straight from the origin returns HTML without that script), but your browser does load it. It sets no Cookie and reads none of your local storage. Whether to turn it off is a domain-level setting owned by the operator; on this point the page describes measured behavior, not intent.

## 3. What the feedback page collects

What you write on `/feedback` is stored on the server so that the matter can be handled to completion. Specifically:

- **The feedback text** (up to 5000 characters), **an optional email address**, and **the address of the page you were on when you submitted** (up to 500 characters). These three go into the database.
- **An optional screenshot**: uploaded with the form as a file; PNG, JPG, WebP and GIF are accepted, up to 8 MB. The screenshot is stored as a file in the server's data directory; the database keeps only a randomly generated identifier name (unrelated to the image's content) — the original filename is not kept.
- To guard against abuse, the server stores **your IP address verbatim** (visible to the admin when handling your feedback) and a **non-reversible source identifier**: HMAC-SHA256 of "your network address + browser category" with a server-side key, keeping only the first 24 characters, used to rate-limit the same source to at most 5 messages per minute. The full User-Agent is not stored.
- At the moment you submit, the server also **queries the third-party service ipwho.is (https) once with your public IP** for its location (city / region / country) and stores it with that feedback, so the back office can show where it came from; private and reserved addresses are never looked up.
- Off-site delivery of feedback (including screenshots) uses exactly one channel: **direct email to the site owner's QQ mailbox (xxc200707@qq.com)** — if you left an email address, the outcome is replied to that address; the screenshot goes to the owner's mailbox with the feedback. The site has no Feishu, WeChat group or other internal collaboration channel; the old Feishu forwarding chain is **retired** (production configures no Feishu items; the sign-in route and the dormant forwarding chain remain in the code). If a new third-party channel is ever added, this page will rewrite this item at that time.

About your feedback you may at any time ask to: see what we stored, correct it, or have it **deleted**. Deletion is a one-click back-office action that clears the text, the email, the page address and the screenshot file, leaving only a content-free processing record (including that non-reversible source identifier), used to stop the same matter from being asked for deletion over and over. Provide the feedback number, or the submission time plus the page address, so that the record can be located. Note that the database is fully backed up once a week (including the feedback table) and uploaded to cloud storage, expiring on a rolling basis after about 56 days; **deletion takes effect immediately on the database in use and the screenshot file, but it does not retroactively purge copies already uploaded to backups** — those copies disappear when they expire.

## 4. Server logs

- **The site's application process does not keep per-request access logs by default**: request logging is turned off; a line is written only when a response status is 5xx or a single request takes more than 1 second, containing only the method, the path without its query string, the status code and the duration. In other words, your search terms, paging cursors and item IDs never enter the log. Cookie and Authorization headers are redacted in logs.
- The web process writes one error line only when it hits an unhandled exception, with no visitor information.
- Back-office sign-in is limited by attempt count: at most 10 attempts per address within 15 minutes and at most 50 site-wide in the same window; the password comparison runs on a constant-time path. These rate limits — like the feedback one and the one on the manual-delivery endpoint — count short windows in process memory keyed by your network address; nothing is written to the database or the logs, and a process restart clears them. The feedback limit additionally keeps a hashed source identifier in the database, see section 3. Every manual admin action (selection, sources, feedback handling) is written to an audit log with the actor, the action, the object, the reason and the before/after values.
- **Your network address does still appear in the access logs of the reverse proxy or CDN** (Caddy, Nginx and the like record the IP, time, request path and browser identity per their own configuration). This site's reverse proxy records the **full request line, including the query string** — that is, the words you searched for on the site and your filter choices; those logs are kept for about 15 days. This layer is configured by the operator, not decided by this software. To be stated here: hosting and reverse-proxy provider: to be filled in by the site owner; access-log retention: to be filled in by the site owner (measured at about 15 days today); whether it sits outside mainland China: to be filled in by the site owner.

## 5. Images are fetched through this site; origin sites cannot see you

Images on an item are not fetched by your browser straight from the origin site:

- Pages reference this site's own signed address (`/api/img-proxy`); the signature is HMAC-SHA256 with a server-side key and carries an expiry (about two days, aligned on day boundaries so caches can be reused); the address contains nothing that identifies you.
- The image is fetched by this site's server, scaled proportionally, cached on the server and then handed to you; cached files older than 30 days are deleted by the daily cleanup job and regenerated when needed.
- Therefore, **when you view an image, the origin site sees only this site's server fetching its own copy — not your IP, your browser, or which item you are reading**. To the origin, the fetch presents this site's crawler identity.
- The single exception is when you deliberately click "open original" (the button labeled 原文 on phones) and jump to the other site — their privacy policy then applies, see section 6.

## 6. Third-party content and external links

This site shows summaries of and links to third-party material. Once you open an original link, you are on the website of the station, agency, journal or outlet; you submit your network address and browser information to them, and their Cookies and analytics apply. This site can neither control that on your behalf nor vouch for how their policies are written. Each source's own privacy terms are on its site.

## 7. Back-office sessions (affects admins only, not readers)

- After back-office sign-in the browser keeps one session Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, plus `Secure` when the site runs on HTTPS, valid for 30 days and cleared immediately on sign-out.
- The database **does not store the Cookie's value** — only its SHA-256; even if the database leaks, it cannot be used to impersonate your signed-in state. Sessions are created with random values and cannot be derived from the account.
- Each session also carries a CSRF token; back-office writes must present it before they execute.
- Each session records a truncated copy of a browser identifier (at most 300 characters), so the admin can tell which device signed in.
- Back-office sign-in is password-only; the third-party account channel (Feishu) is **retired**: production configures no Feishu items, and the sign-in route and the dormant forwarding chain remain in the code. The admin's email address (used to reply to readers) is stored in the admin account table and used only for authentication and auditing.

## 8. What this site does not do

This site **has no** such mechanisms — a positive statement you can verify:

- This site runs no third-party statistics, analytics, attribution, advertising or recommendation scripts, and has no pixels, fingerprinting or cross-site tracking; no JavaScript is loaded from outside this site's own code. The only third-party script that might appear in your browser is the Cloudflare statistics beacon at the domain level (end of section 2), injected by Cloudflare rather than introduced by this site; it sets no Cookie, and turning it on or off is the operator's domain setting.
- Personal information is not sold, rented or exchanged, and no reader data is provided to any third party.
- No emails or push notifications are sent to readers; subscriptions run over RSS through your reader — this site does not know who is subscribed.
- No user profiling; feedback, saved items and read markers are never linked to any identity.
- Opening a page triggers no model calls; classification, scoring and writing happen only in back-office tasks. The back office calls the configured third-party model service and sends it **the sources' own titles and text**, to generate Chinese titles, summaries, categories and scores — it carries none of your browsing history, identity or preferences; what is processed is source content, not your personal data. Image proxying may reach origin sites; that behavior is in section 5.

## 9. How this page changes, and the placeholders awaiting the site owner

Changes to this page are recorded in the changelog (`/changelog`), and the version and effective-date rows are updated at the same time. If a statistics service, internal forwarding channel or third-party sign-in is ever added, this page rewrites the affected items before it takes effect.

Filled in only after the site owner confirms in person; the site does not invent these:

- **Contact (published)**: `SITE.contactEmail` is already `xxc200707@qq.com`, and the contact lines of `/.well-known/security.txt` and `llms.txt` include it automatically. The day-to-day channel for readers is the `/feedback` page (anonymous, no sign-in); replies and outcomes go out by direct email. This site runs under the sub-path `/geohot/`, so RFC 8615 scanners look for `.well-known/security.txt` at the domain root; whether the deployment should also point the root path here remains the site owner's call.
- **Hosting and access logs**: the hosting provider, log retention and server location left open in section 4.
- **Applicable jurisdiction**: this page does not yet name the jurisdiction and venue governing personal-information protection; to be confirmed by the site owner before launch — cross-border sources and hosting abroad need professional advice.
- **Retention period**: how long feedback is actually kept before deletion (the current code never expires it automatically; the site owner must set an enforceable deadline).
- **Branding prefixes**: the browser-local-storage key names (`aihot-*`), the session-storage key used for scroll positions (`react-router-scroll-positions`) and the back-office Cookie name (`aihot_admin`) still carry the upstream framework's prefix; changing them all to this site's brand means changing constants in `apps/` and `packages/` — a code change, not a copy change.
- **Whether the site owner reviews it in person**: this page makes promises about personal-information handling; it is advisable to have a professional read it before launch.
