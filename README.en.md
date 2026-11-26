<sub>🌐 <a href="README.md">中文</a> · <b>English</b> · <a href="docs/manual.md">Operations &amp; Development Handbook</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="GEOHOT mark: a teal hotspot at the intersection of latitude and longitude" width="72">

# GEOHOT · Geography in Focus

**A daily reading of a changing world.**

> The tremor of an earthquake, the shifting edge of a city, a fresh pass from an Earth-observation satellite—every day, the planet leaves new geographic traces.<br>
> GEOHOT watches **1,000** public geography sources continuously, weighs each report by its **spatial significance**, gathers related coverage into unified events, and composes daily geography editions built to be revisited.

**Read the essentials. Follow the evidence. Return to the source.**

[![Read online](https://img.shields.io/badge/Read_online-xxc2007.me%2Fgeohot%2Fen-D97757)](https://xxc2007.me/geohot/en/)
[![中文版](https://img.shields.io/badge/中文版-xxc2007.me%2Fgeohot-176B75)](https://xxc2007.me/geohot/)
[![Stack](https://img.shields.io/badge/Stack-TypeScript_·_React_·_PostgreSQL-1F1E1D)](#architecture)
[![MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Free to read with no account required—now featuring a **native English reading edition** ([`/geohot/en/`](https://xxc2007.me/geohot/en/)) alongside Chinese,<br>
complete with full-text search, discipline filters, local bookmarks, RSS, Public REST API, and AI Agent **MCP**.

[Film](#-product-film) · [Reading Experience](#reading-experience) · [Selection Pipeline](#how-material-becomes-a-selected-story) · [Architecture](#architecture) · [Open Interfaces](#pages-and-open-interfaces) · [Reliability](#reliability-and-observability) · [Run Locally](#local-development-and-adaptation) · [Content Boundaries](#content-boundaries--license) · [License](#-license) · [Star History](#star-history)

</div>

<p align="center">
  <a href="https://xxc2007.me/geohot/en/"><img src="docs/shots/home-light-en.png?v=ad7c3aee14" alt="GEOHOT English edition selected feed: seven categories, search, trending events, and chronological story cards" width="820"></a>
</p>
<p align="center"><sub>English edition · disciplines, trending events, and chronological stream · captured live on 25 November 2026 · also available in warm paper light &amp; dark telemetry themes</sub></p>

## 🎬 Product Film

Our new **72-second · 1080p 60fps** official launch film (available in both English and Chinese editions): nine kinetic motion-graphics acts walking through the graticule mark, a rotating 3D globe of global public sources, a 3D perspective sweep of the native English `/geohot/en/` reading interface, the dark-telemetry spatial-salience scoring engine, multi-source event merging with 24h half-life heat decay, the 08:00 daily brief, and open RSS / API / MCP outputs—scored to an original 124 BPM stereo soundtrack and frame-synced foley.

Play directly below:

https://github.com/user-attachments/assets/eaa7ba7b-ebf7-4cea-b89d-944dca303d94

[▶ Watch in the 1080p player](https://xxc2007.me/assets/promo/geohot/?v=20261016) · [Open English MP4](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo-en.mp4) · [Chinese MP4](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo.mp4)

<sub>1920 × 1080 · 60fps · Stereo AAC. Footage reflects live site snapshots at capture time; visit the site for current coverage.</sub>

## Reading Experience

### Follow the story beyond a single dispatch

Every card surfaces a concise headline, summary, editorial rationale, source attribution, and selection score so you can judge what merits a deeper read. When multiple observatories, agencies, or journals report on the same development, GEOHOT merges them into one **event page** with a synthesis and chronological timeline—always preserving original source links for direct verification.

### Native bilingual coverage, oriented by discipline and edition

Alongside the Chinese edition (`/geohot/`), GEOHOT now serves a **native English interface** (`/geohot/en/`) covering the Selected feed, Trending events, Topics, About page, and bilingual publication pipeline. A **Daily Edition** publishes every morning at **08:00 Asia/Shanghai** alongside weekly and monthly archives (**320+** daily editions published, **134,000+** items collected, **7,190+** selected).

| Category | Scope |
|---|---|
| **Physical Geography** | Landforms, climate, hydrology, soils, vegetation, and natural hazards |
| **Human Geography** | Population, cities, industry, transport corridors, and urban–rural change |
| **Regional Geography** | Integrated transformations across basins, polar zones, plateaus, deltas, and city clusters |
| **Political Geography** | Borders, territory, strategic passages, and maritime rights |
| **Historical Geography** | Shifting rivers and coastlines, administrative evolution, historic settlements, and archival maps |
| **Frontier Research** | New scientific evidence, methods, datasets, and breakthroughs in Earth system research |
| **GIS** | Remote sensing, positioning, spatial data standards, GIS platforms, and open-source tooling |

Full taxonomy definitions live in [`industry/taxonomy.ts`](industry/taxonomy.ts). Bookmarks stay purely in your local browser; RSS, public APIs, and MCP carry the same content into personal readers and automated workflows.

## How Material Becomes a Selected Story

**Collect & deduplicate → Pre-filter → Two independent scores → Tiered thresholds → Event grouping → Heat decay → Scheduled editions**

| Stage | How It Works |
|---|---|
| **Sources & Pre-filtering** | Polls 1,000 registered public sources (RSS / Web / JSON), deduplicates by normalized URL, and screens for genuine geographic relevance—blocking tourism promos and boilerplate ([`sources.json`](industry/sources.json), [`prefilter.md`](industry/prompts/prefilter.md)). |
| **Scoring & Admission** | Runs **two independent scoring passes** against a spatial-significance rubric. Their sum is checked against source-tier gates (more forgiving for primary agencies, stricter for media); cards display the average ([`selection.ts`](industry/selection.ts)). |
| **Events & Heat** | Consolidates multi-source coverage into shared events. Heat weighs independent-source breadth against time decay (48h window, 24h half-life); if nothing qualifies, the board stays honestly empty. |
| **Writing & Publication** | Produces bilingual headlines, summaries, rationales, event syntheses, and editions. All public channels read through [`publication/`](packages/backend/src/publication/) for strict consistency. |

> **Humans set the editorial standard; models evaluate individual items.** Taxonomy, sources, prompts, and thresholds live cleanly in [`industry/`](industry/). Scores guide triage rather than expressing factual probability.

## Architecture

Built on the open-source [AIHOT](https://github.com/KKKKhazix/AIHOT) framework, GEOHOT isolates all geography domain knowledge in `industry/`, while core applications and shared packages reside in `apps/` and `packages/`.

| Layer | Choice & Responsibility |
|---|---|
| **Runtime & Workspace** | Node.js 24 runs backend TypeScript natively; npm workspaces coordinates apps, packages, and domain config ([`package.json`](package.json)). |
| **Web Frontend** | React Router SSR, React, and Tailwind CSS powering native bilingual feeds, events, editions, and themes. |
| **HTTP API** | Fastify serves public read-only endpoints and authenticated management routes over HTTP. |
| **Data & Queues** | PostgreSQL stores items, events, editions, and sessions; `pg-boss` manages async queues and schedules. |
| **Model Pipeline** | Background workers execute analysis, translation, and writing under [receipt & budget guardrails](packages/backend/src/providers/receipts.ts); public reading never triggers model calls. |
| **Output Consistency** | Web, RSS, REST API, and MCP share one unified publication read layer. |

### How It Works

[![GEOHOT · From public sources to readers](docs/architecture/flow.en.630ca94064fa.png)](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/architecture/flow.en.630ca94064fa.png)

<sub>Click for 3600 px PNG · [Editable SVG source](docs/architecture/flow.en.svg) · Architecture &amp; directory map in [PROJECT-MAP.md](docs/PROJECT-MAP.md).</sub>

## Pages and Open Interfaces

Paths below are relative to `/geohot/` (English routes under `/geohot/en/`):

| Route | Purpose |
|---|---|
| `/` · `/en/` · `/all` | Bilingual Selected feed and searchable All Updates archive |
| `/story/:publicId` · `/items/:id` | Event overviews, reporting timelines, and individual dispatches |
| `/hot` · `/topics` | Live trending events and ongoing geographic topic hubs |
| `/daily` · `/weekly` · `/monthly` | Daily, weekly, and monthly editions plus full archives |
| `/starred` · `/agent` · `/feedback` | Local browser bookmarks, developer / MCP docs, and reader feedback |

- **RSS**: Selected [`/feed.xml`](https://xxc2007.me/geohot/feed.xml), all updates `/feed/all.xml`, daily `/feed/daily.xml`, plus category feeds.
- **Public API**: Read-only JSON under `/api/v1/` ([`openapi-v1.json`](https://xxc2007.me/geohot/openapi-v1.json)).
- **AI Agent MCP**: Native MCP endpoint `/api/mcp` with `/llms.txt` ([integration page](https://xxc2007.me/geohot/agent)); live counts at [site statistics](https://xxc2007.me/geohot/api/site/stats).

## Reliability and Observability

- **Pre-Computed Usage Snapshots**: Admin usage overviews read 24-hour disk-cached snapshots refreshing every 30s, serving instant figures with graceful stale fallback ([cost accounting notes](docs/admin-official-pricing.md)).
- **Public Health Probe**: `/api/health` cleanly separates transient load (`gate_busy`, `query_timeout`) from real database faults (`conn_error`, `db_unavailable`).
- **Reader-First Priority**: Reader-facing pool floors (DB ≥ 8, queue ≥ 3) are enforced at the server environment layer; reader availability always outranks backfills and diagnostics.

## Local Development and Adaptation

Requires **Node.js 24.11+** (full runbook in [`docs/manual.md`](docs/manual.md)):

```bash
npm ci
npm run env:init
```

Run tests against an isolated throwaway database ending in `_test` or `_ci` (pass `DATABASE_URL` via shell only, never layer `.env`):

```bash
node --input-type=module -e "import postgres from 'postgres'; const s = postgres('postgres://geohot:geohot@127.0.0.1:5433/postgres'); await s.unsafe('CREATE DATABASE geohot_test'); await s.end();"
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_test npm run db:migrate
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_test npm test
```

Adapt to another domain by customizing `industry/` (see [customisation guide](docs/customize.md) & [runbook](docs/geohot-runbook.md)).

## Content Boundaries & License

Summaries, scores, and syntheses are reading aids; always verify critical figures against original sources. Hazard coverage is never an official emergency alert.

## 📄 License

[MIT](LICENSE) © 2026 数字生命卡兹克 (upstream framework). Geography domain configuration, bilingual runtime, and brand maintained by Xiong Xinchen (熊鑫晨). Upstream copyright preserved in [NOTICE](NOTICE).

## Star History

<p align="center">
  <img src="https://api.star-history.com/svg?repos=xxc2007/GeoHot&type=Date" alt="GitHub star history for the GEOHOT repository" width="100%">
</p>

---

<div align="center">
  <sub>Follow the news. Return to the earth.<br>Editorial standards &amp; code · Xiong Xinchen · <a href="https://xxc2007.me/geohot/en/">English</a> · <a href="https://xxc2007.me/geohot/">中文</a></sub>
</div>
