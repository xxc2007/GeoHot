// Reverify active reserve sources: robots.txt fail-closed + feed reachability + item count sanity.
//
// Usage:
//   node scripts/reverify-reserves.ts                # dry-run, no writes
//   node scripts/reverify-reserves.ts --write        # update checkedAt for passes, mark failures
//   node scripts/reverify-reserves.ts --limit 30     # max 30 (hard cap)
//
// Safety:
//   - Skips every entry with _excludedReason already set.
//   - Skips ids already in sources.json.
//   - robots.txt: 404/410 allows; other non-200 rejects (fail-closed); 200 parses Disallow.
//   - feed: 15s timeout, requires >=5 items and a 2026 date marker.
//   - Never touches the database. Writes only industry/source-reserves.json when --write is passed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const doWrite = args.includes("--write");
const limitIdx = args.indexOf("--limit");
const limit = Math.min(Math.max(limitIdx >= 0 ? Number(args[limitIdx + 1]) || 30 : 30, 1), 30);

const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/source-reserves.json"), "utf8")) as { sources: Array<Record<string, any>> };
const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: Array<{ id: string }> };
const packIds = new Set(pack.sources.map((s) => s.id));

const candidates = manifest.sources
  .filter((s) => !s._excludedReason)
  .filter((s) => !packIds.has(s.id))
  .filter((s) => s.kind === "rss" && (s.tier === "T1" || s.tier === "T1_5"))
  .slice(0, limit);

console.log(`[reverify] mode=${doWrite ? "WRITE" : "DRY-RUN"} limit=${limit} selected=${candidates.length}`);

const results = [];
const nowIso = new Date().toISOString();
let freshCount = 0;
let failCount = 0;

for (const s of candidates) {
  const url = s.config.feedUrl || s.config.url;
  const t0 = Date.now();
  const rec = { id: s.id, url, tier: s.tier, status: "pending", items: 0, ms: 0, note: "" };
  try {
    // robots fail-closed
    const u = new URL(url);
    const robotsTxtUrl = `${u.protocol}//${u.host}/robots.txt`;
    const rRes = await fetch(robotsTxtUrl, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; GeoHot/1.0; +https://xxc2007.me/geohot/about)" },
      signal: AbortSignal.timeout(8000),
    });
    if (rRes.status === 200) {
      const robotsText = await rRes.text();
      let applyToStar = false;
      let disallowed = false;
      for (const rawLine of robotsText.split(/\r?\n/)) {
        const line = rawLine.split("#")[0].trim();
        if (!line) continue;
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (field === "user-agent") { applyToStar = value === "*"; continue; }
        if (!applyToStar) continue;
        if (field === "disallow" && value && u.pathname.startsWith(value)) { disallowed = true; break; }
      }
      if (disallowed) { rec.status = "robots_disallowed"; rec.note = "Disallow matched"; }
    } else if (rRes.status !== 404 && rRes.status !== 410) {
      rec.status = "robots_unreachable"; rec.note = `HTTP ${rRes.status}`;
    }
    if (rec.status === "pending") {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; GeoHot/1.0; +https://xxc2007.me/geohot/about)", accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
        signal: AbortSignal.timeout(15000),
      });
      rec.status = `http_${res.status}`;
      if (res.status === 200) {
        const text = await res.text();
        const items = (text.match(/<item[ >]/g) || text.match(/<entry[ >]/g) || []).length;
        rec.items = items;
        if (items < 5) { rec.note = `only ${items} items (<5)`; }
        else if (!/2026/.test(text)) { rec.note = "no 2026 date marker"; }
        else {
          rec.status = "pass";
          rec.note = `${items} items, has 2026 dates`;
          freshCount++;
          if (doWrite) s.validation = { ok: true, checkedAt: nowIso, items };
        }
      }
    }
  } catch (e) {
    rec.status = "error";
    const msg = e instanceof Error ? e.message : String(e);
    rec.note = msg.slice(0, 80);
  } finally {
    rec.ms = Date.now() - t0;
    if (rec.status !== "pass") {
      failCount++;
      if (doWrite && !s._excludedReason) s._excludedReason = `reverify-${rec.status}: ${rec.note}`;
    }
    results.push(rec);
    console.log(`  ${rec.status.padEnd(20)} ${rec.id.padEnd(42)} items=${String(rec.items).padStart(3)} ${rec.ms}ms ${rec.note}`);
  }
}

if (doWrite) {
  writeFileSync(path.join(REPO_ROOT, "industry/source-reserves.json"), JSON.stringify(manifest, null, 2) + "\n");
}

console.log(`\n[reverify] done: passed=${freshCount} failed=${failCount} total=${results.length} write=${doWrite}`);
if (failCount / results.length > 0.5) console.log("[reverify] WARNING: >50% failure rate — do not proceed to next batch without review.");
