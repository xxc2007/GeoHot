<sub>🌐 <a href="README.md">中文</a> · <b>English</b> · Full handbook: <a href="docs/manual.md">docs/manual.md</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="Where the lines cross: an ink globe cut by one meridian and three parallels, a cyan hot spot sitting on their intersection" width="72">

<p><sub>GEOGRAPHY · HOTSPOT · DAILY &nbsp;—&nbsp; filtered by spatial salience · every item links to its source · no forecasting</sub></p>

# GEOHOT

> *「News about this land arrives every day. Only a few items are worth writing down with evidence behind them.」*

[![Live](https://img.shields.io/badge/%F0%9F%8C%90_Live-xxc2007.me%2Fgeohot-D97757)](https://xxc2007.me/geohot/)
[![Repository](https://img.shields.io/badge/GitHub-GeoHot-1F1E1D)](https://github.com/xxc2007/GeoHot)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![No accounts](https://img.shields.io/badge/Readers-no_signup_·_no_cookies-1F1E1D)](#ii--site-map)
[![Categories](https://img.shields.io/badge/Categories-seven-D97757)](#i--taxonomy--seven-categories-one-standard)
[![Runtime](https://img.shields.io/badge/Runtime-Node_24_·_no_backend_build-1F1E1D)](#iii--stack)
[![Field layer](https://img.shields.io/badge/Whole_field_layer-industry%2F-1F1E1D)](#iv--reuse-it-for-your-field)
[![GitHub](https://img.shields.io/badge/GitHub-@xxc2007-1F1E1D)](https://github.com/xxc2007)

<br>

**Every day I read the geography beat once and keep only the few items that hold up.**

It watches observatories, satellite agencies, statistics and boundary departments, filters by **spatial salience**,
writes a Chinese title and summary for the survivors, merges multiple reports of one happening into a single event,
and publishes a daily edition at 08:00 Asia/Shanghai. Free, no registration, and every item keeps its original link.

It is built on the open-source framework [AIHOT](https://github.com/KKKKhazix/AIHOT) (MIT) with the industry layer
swapped for geography: the engine lives in `apps/` and `packages/`, and everything geography-specific — site name,
taxonomy, topics, sources, scoring standard, thresholds, branding, terms pages — lives in one folder,
[`industry/`](industry/).

<br>

[🎬 Product film](#-product-film) · [I Highlights](#i--highlights) · [II Site map](#ii--site-map) · [III Stack](#iii--stack) · [IV Reuse it for your field](#iv--reuse-it-for-your-field) · [V Run it locally](#v--run-it-locally) · [VI Boundaries and notes](#vi--boundaries-and-notes) · [VII License](#vii--license-and-provenance) · [VIII Star history](#viii--star-history) · [Full handbook](docs/manual.md)

<br>

> **This page says what the thing is, not how much of it exists today.**
> Source counts, item counts, edition numbers and threshold values all move daily; transcribing them here would make
> this page wrong tomorrow. So this page gives **endpoints and filenames instead of numbers**: live figures from
> [`/api/site/stats`](https://xxc2007.me/geohot/api/site/stats), the source ledger from
> [`industry/sources.json`](industry/sources.json), current thresholds from [`industry/selection.ts`](industry/selection.ts).
> Operational detail (how to run it here, port map, checks, pre-launch list) is in
> [`docs/manual.md`](docs/manual.md); section 9 of that file states which docs to trust and how far.

</div>

---

<p align="center">
  <a href="https://xxc2007.me/geohot/"><img src="docs/shots/home-light.png" alt="GEOHOT front page: a current-hotness strip on top, a chronological shortlist below, topic and daily entries in the sidebar" width="820"></a>
</p>

<details>
<summary>▲ Figure 1 · HOME, the shortlist — open to see what is in this shot and why it may look different tomorrow</summary>

The block at the top is **current hotness**, and this shot catches it in its **empty state**: the board only exists once
two independent outlets are discussing the same event, and when nothing clears that bar the page says so plainly —
"no event in the past 48 hours has two independent sources discussing it" — plus an `/all` entry point, rather than
wiping the layout blank. When a board does exist, the same slot lists the top events: rank, headline, the outlets
arguing about it, a heat value and a trend arrow, and the title may carry a cut-off timestamp for that board.
**This screen changes daily; the live URL is the source of truth**: <https://xxc2007.me/geohot/>.

</details>

---

---

## 🎬 Product film

A 35.4-second, 1080p film built from real public website captures, using Video Shotcraft. Camera motion and the presentation follow the Nanchang No. 15 memorial film; colours and typography come from this website. The film has Chinese captions. GEOHOT news footage is a frozen capture from 8 October 2026.

Play the film directly in the player below.

https://github.com/user-attachments/assets/0f0d31b0-eaf2-4155-833e-5155f7391110

[Watch in 1080p](https://xxc2007.me/assets/promo/geohot/) · [Source MP4](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo.mp4)

The native README preview is 1920×1080; the standalone player and source link use the full 1080p film.

---

## I · HIGHLIGHTS

### i · TAXONOMY — seven categories, one standard

The taxonomy is the skeleton (`industry/taxonomy.ts`; keys go straight into URLs and do not change after launch).
All seven share one admission standard — **spatial salience first**: large scale of impact, independently reported by
several outlets, backed by data / figures / imagery. All three must hold for an item to rank high.

| Key | Category | Covers |
|---|---|---|
| `physical` | Physical geography | Landforms, climate, hydrology, soils, vegetation and hazard events — observation data, figures or imagery required |
| `human` | Human geography | Population and migration, urbanisation, industry and transport location, administrative boundary changes, urban-rural and regional policy |
| `regional` | Regional geography | Whole-system change at region or basin scale: polar regions, the Qinghai-Tibet Plateau, deltas, city clusters, transboundary rivers |
| `geopolitics` | Political geography | Sovereignty, boundary and territory demarcation and disputes, strategic chokepoints, transboundary rivers and maritime rights |
| `histgeo` | Historical geography | River and coastline shifts, administrative evolution, rise and abandonment of settlements, historical maps |
| `geotech` | GIS | Remote sensing and imagery, positioning, dataset and standard releases, GIS software and platforms, spatial databases, WebGIS, open-source licensing changes |
| `geoedu` | Graduate entrance exams | Geography admissions policy and programme catalogues, discipline and degree points, syllabi and cut-off scores |

**There is no "boards" layer.** Four cross-category direction pages (`/boards`) existed and were deleted on the
owner's instruction as redundant — the topic pages and the category filter already do that job. Only the view was
removed: items, the `category` field, the taxonomy and the public thresholds were untouched. `/boards` now returns
404, and the four directions are reachable through the category filter (`/all?category=<key>`) and the topic pages.

### ii · PIPELINE — seven steps from raw item to published page

**collect → pre-filter → two independent scorings → threshold → merge into events → heat → editions**

- **Pre-filter** (`industry/prompts/prefilter.md`): is this a geography matter at all, and does it contain real
  information. Anything blocked here never appears on any public page.
- **Two independent scorings**: the same rubric is called twice in series; an item is admitted only when the two
  scores together clear the line. The card shows their average, floored.
- **Threshold by source tier**: sources sit in `T1` / `T1_5` / `T2`, and the line is lower for the more authoritative
  tier. There is a second, lower line for items that are not admitted but still worth reading.
  **Current values and the arithmetic live only in the header comment of
  [`industry/selection.ts`](industry/selection.ts), which also states plainly that this set is not yet calibrated against a gold set.**
- **Merge into events**: several reports of one happening become one event with its own summary page. Admitted items
  wait for grouping to finish before appearing in the shortlist, so the same story cannot surface three times.
- **Heat**: a rolling time window, decay over time, one vote per independent source, and a minimum number of
  participants — below that the board is simply empty. An empty board is an honest state, not a fault.
  The three parameters (window, half-life, minimum participants) live in `packages/backend/src/events/hot.ts`.
- **Editions**: daily, weekly and monthly editions are generated at fixed times, items ranked by heat and split into
  discipline and technology sections.

### iii · BRAIN — humans set the standard, the model makes each call

This boundary is written into the terms, not left to implication: the taxonomy, the definition of importance, the
noise list, the thresholds and the prompts are all confirmed item by item by the owner and committed under
`industry/`. The model returns per-item judgements against that standard; the owner spot-checks and overrides in the
admin, and readers can flag errors through feedback.

Every sentence shown to a reader must match who actually produced it: **a machine-written summary is never presented
as an editorial position.** Better one short item than one wrong hazard figure.

---

## II · SITE MAP

| Route | Contents |
|---|---|
| `/` · `/all` | Shortlist · full stream (with search) |
| `/hot` | Hot topics board (ranked by event, not by item) |
| `/daily` · `/daily/archive` · `/daily/:key` | Latest edition · archive · one edition; `/weekly` and `/monthly` are isomorphic |
| `/topics` · `/topics/:slug` | Topic index and single topic page (topic count is defined by `industry/topics.json`) |
| `/story/:publicId` · `/items/:id` | Event page (reports merged) · item page, plus `/items/:id/original` for the source jump |
| `/about` · `/agent` · `/changelog` · `/feedback` · `/terms` · `/privacy` · `/more` | About · agent access · changelog · feedback · terms · privacy · more |
| `/starred` | Saved items — stored only in this device's browser, `noindex` |
| `/admin/*` | Admin, **login required** (password is `ADMIN_PASSWORD`, generated into `.env` by `npm run env:init`) |

**Machine-readable exits** all read from one read-only layer, `packages/backend/src/publication/`, so the web pages
and the APIs serve the same set of items:

- RSS: `/feed.xml` (shortlist), `/feed/full.xml` (shortlist with body), `/feed/all.xml`, `/feed/daily.xml`, `/feed/weekly.xml`, `/feed/monthly.xml`, plus per-category `/feed/category/<key>.xml` and `/feed/full/category/<key>.xml`
- Public API: read-only endpoints under `/api/v1/*`, spec at `/openapi-v1.json`, agent page at `/agent`
- For agents: an MCP endpoint and `/llms.txt`
- Indexing: `/sitemap.xml`, `/robots.txt`

Readers get no login, no cookies, no analytics. Bookmarks live in local storage. Admins and visitors see the same content.

---

## III · STACK

Each layer is the option that "runs with one command on this machine and needs no extra middleware". Exact versions
belong to `package.json` and are not transcribed here.

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 24** executing TypeScript directly | No build step on the backend: change it, run it, one less artifact that can lie |
| Layout | **npm workspaces**: `apps/*`, `packages/*`, `industry` | One change visible repo-wide, no release coordination |
| Front end | **React Router** (SSR) + React + Tailwind | Server-rendered, so crawlers and readers get complete HTML |
| API | **Fastify** | Public reads must take load; admin writes must take validation |
| Jobs | **pg-boss** | The queue lives inside Postgres — one less middleware to operate |
| Data | **PostgreSQL** | Items, events, reports and sessions share one relational store; `embedded-postgres` locally, no Docker dependency |
| Editorial judgement | A real model in production; a local stub plus `tooling/fixtures/*.jsonl` locally and in CI | Paid calls always pass receipts and a budget breaker; tests never touch an external service |

---

## IV · REUSE IT FOR YOUR FIELD

`industry/` is where everything geography-specific belongs; the rest is a general engine. **Swapping verticals should
touch that one directory.** That is the most copyable property of this repository. Steps are in
[`docs/customize.md`](docs/customize.md) — its *procedure* holds, its *numbers* do not.

| File | Owns |
|---|---|
| `site.ts` | Site name, the industry noun `subject` (composed into edition and list titles), home and about copy, MCP tool-name prefix, contact email |
| `taxonomy.ts` | Categories, content types, tag vocabularies, institution roster, identity dictionary that prevents misattribution |
| `topics.json` | Topic index (`/topics`); take the count from this file, never from documentation |
| `sources.json` | Sources imported on first boot (`ON CONFLICT DO NOTHING` — additive only; afterwards manage them in the admin) |
| `prompts/` | Admission standard, writing requirements, noise examples — **the industry know-how lives here**, so changing the standard needs no code change |
| `selection.ts` | Thresholds and floors; the header comment is the arithmetic plus the "not calibrated" statement |
| `features.ts` | Modules irrelevant to this industry are switched off here |
| `brand/` | Icons and the edition nameplate (generated from `SITE.subject` by a script; re-run it after changing the noun) |
| `pages/` | `terms.md`, `privacy.md` — templates until the human in charge confirms them |

Ask the operator rather than deciding for them: the site name; which sources to watch; what counts as important and
what counts as noise; how to divide categories; and the contents of the terms and privacy pages.

---

## V · RUN IT LOCALLY

**The first step in a clean clone is `npm run env:init`, not starting the stack after `npm ci`.**
Every `.env` file is gitignored, so a clone has none, and the documented start commands pass `--env-file=.env` —
Node reports `.env: not found` and exits with code 9. `scripts/init-env.ts` writes those files, generates real random
values for each secret, and **refuses to overwrite existing ones**.

How to run it on this machine, the port map, start order, and what to do when the default ports are already taken are
all in **section 3 of [`docs/manual.md`](docs/manual.md)**. That file is the operational reference; `docs/deploy.md`
is the upstream Docker route and this machine has no Docker.

At minimum, after a change:

```bash
npm run typecheck
npm test                        # test databases must end in _test / _ci; setup rejects anything else
npm run build -w @aihot/web
node scripts/smoke.ts --base http://localhost:3000
```

Every safety valve is off by default (collection, model calls, embeddings, Feishu, IndexNow). To run the pipeline for
real, **layer a one-off env file** (`--env-file=.env --env-file=.env.pipeline`) rather than merging those switches
into `.env` — that would make the tests call external services.

---

## VI · BOUNDARIES AND NOTES

- **No transcribing numbers that move.** Anything countable in this page and in `docs/` is a pointer instead.
  An earlier version copied a live snapshot and concluded from it that production lagged the local database; both
  halves were false. Chasing a moving number by transcription cannot work — that is the rule, not an oversight.
- **Empty states are part of the design.** A topic page may legitimately show zero items, a thin edition says how
  thin it is, and the hot board is empty when nothing clears the bar. Empty states are built as pages, not hidden as bugs.
- **Where a reader might act, there is a disclaimer.** Items carrying a hazard label render "this site is not a
  warning authority; this page is not a basis for warnings" on the item itself, not buried in `/terms`.
- **Thresholds are empirical guardrails, not proofs.** The header comment of `industry/selection.ts` works the
  arithmetic out for you: the hard caps seal only one or two axes, so reading the current thresholds as "a marketing
  piece mathematically cannot be admitted" misreads that document. What actually stops noise at the floor is the
  pre-filter and the source tiering.
- **Sources show summary plus original link by default** (`site_fulltext` off); full text only where the publisher allows it.
- The package scope `@aihot/*`, the folder name `industry/` and the browser storage keys are internal identifiers
  that are never shown to readers. Renaming them is a deliberate non-change; the size of that job is countable with
  `grep` at any moment and is not transcribed here.

---

## VII · LICENSE AND PROVENANCE

The code is **MIT**: [`LICENSE`](LICENSE) preserves the upstream text unchanged, and the copyright line still names
the author of the upstream framework [AIHOT](https://github.com/KKKKhazix/AIHOT) — this site added no copyright line
of its own. [`NOTICE`](NOTICE) likewise preserves the upstream portion and only **appends** a derivative notice
explaining that this tree is a modified derivative, what changed, and that no upstream name is used.

Two things must be said plainly: the upstream `NOTICE` states **"The name "AIHOT" and the AIHOT logo are not licensed
under the MIT License"**, so this site reuses neither, and the textual derivative claim is not endorsement by
upstream. Third-party assets remain under their own terms (fonts under SIL OFL, institutional marks owned by their
respective bodies) — `NOTICE` does not license those for you. `industry/sources.json` lists publicly available feeds;
copyright of their content stays with the publishers.

---

## VIII · STAR HISTORY

<p align="center">
  <img src="https://api.star-history.com/svg?repos=xxc2007/GeoHot&type=Date" alt="Star history: this repository's GitHub stars over time" width="100%">
</p>

▲ The curve is generated live by <a href="https://star-history.com">star-history.com</a>, so it moves whenever the count does (GitHub proxies images, so updates lag by a few hours). The repository is young; this line starts at the first star.

---

<div align="center">
  <sub>For every message with coordinates, with data, and someone who goes back to check.<br>Editorial standards and code · Xiong Xinchen &nbsp;|&nbsp; per-item judgements run by a model; the standard is written in <code>industry/prompts/</code> &nbsp;|&nbsp; 2026<br><a href="docs/manual.md">docs/manual.md</a> · <a href="docs/geohot-runbook.md">docs/geohot-runbook.md</a> · live at <a href="https://xxc2007.me/geohot/">xxc2007.me/geohot/</a></sub>
</div>
