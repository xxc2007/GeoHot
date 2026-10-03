// The one published-date rule every entrance uses: an RSS/Atom feed, a JSON API, a listing page, a
// detail page, and the external ingest endpoint.
//
// Before this there were four rules (rss.ts tried Date.parse only, json-list.ts had its epoch and
// yyyymmdd branches, web-list.ts had the loose rule, ingest/items.ts used `new Date(string)`). They
// disagreed about the one thing that decides which newspaper day an item belongs to: a zone-less
// timestamp. Date.parse reads "2026-09-26 10:00" in the HOST zone — UTC in the container,
// Asia/Shanghai on a developer machine — so the same item landed eight hours apart depending on where
// the process ran, still inside the 48 h stale window, so the item was never marked history: it simply
// joined the wrong day. Here a value without its own zone is read in the source's offset instead
// (`publishedAtUtcOffset` in the source config), and only that offset's default is a policy choice.

/** Most sources of this site are Chinese; a listing that prints no zone means Beijing time. */
export const DEFAULT_UTC_OFFSET = "+08:00";

/** A time followed by its zone: "10:00Z", "10:00:00+08:00", "10:00:00 +0000", "10:00:00 GMT". */
const EXPLICIT_ZONE = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT)\b/i;

/** A calendar day at a fixed offset; Date.parse would use the host's zone for a zone-less value. */
function atOffset(y: string | number, mo: string | number, d: string | number, h: string | number, mi: string | number, s: string | number, utcOffset: string): Date | null {
  const p = (n: string | number) => String(n).padStart(2, "0");
  const t = Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}${utcOffset}`);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The offset a value is read in when it carries no zone of its own. */
function offsetOf(opts: { utcOffset?: string | null | undefined }): string {
  const raw = String(opts.utcOffset ?? DEFAULT_UTC_OFFSET).trim();
  return /^[+-]\d{2}:?\d{2}$/.test(raw) ? raw : DEFAULT_UTC_OFFSET;
}

/** An epoch in milliseconds or seconds; a value that is not a finite number is "no date", not Invalid Date. */
function fromEpoch(value: unknown, unit: "epoch_ms" | "epoch_s"): Date | null {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const ms = unit === "epoch_s" ? n * 1000 : n;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** 20260922: a calendar day at UTC midnight, some list APIs' way of giving a date. */
function fromYmd(value: unknown): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const d = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  // A day the calendar does not have (20260230) rolls over: that is no date, not February 30.
  return Number.isFinite(d) && new Date(d).toISOString().startsWith(`${m[1]}-${m[2]}-${m[3]}`) ? new Date(d) : null;
}

/**
 * A published date as a feed, an API, a page or a report prints it. Date.parse is used only where it
 * reads the same on every host: a value with its zone, and an ISO date alone (UTC midnight). Anything
 * else — a zone-less time, "2026年9月26日", "Sep 26th, 2026", an RFC 822 date with a Chinese weekday —
 * is taken apart and placed in the source's offset. Null means the source gave no usable date; an
 * Invalid Date never leaves this function.
 */
export function parsePublishedAt(value: unknown, opts: { utcOffset?: string | null; unit?: string | null } = {}): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const unit = opts.unit ?? "";
  if (unit === "epoch_ms" || unit === "epoch_s") return fromEpoch(value, unit);
  if (unit === "yyyymmdd") return fromYmd(value);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? fromEpoch(value, "epoch_ms") : null;

  const v = String(value).replace(/星期[一二三四五六日天]/, "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (EXPLICIT_ZONE.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const direct = Date.parse(v);
    if (Number.isFinite(direct) && /\d{4}/.test(v)) return new Date(direct);
  }
  // 2026-09-26 / 2026/09/26 / 2026-09-26T10:00 / 2026年9月26日 (+ an optional zone-less time).
  const m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(?:T|\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
    const inZone = atOffset(y!, mo!, d!, h, mi, s, offsetOf(opts));
    if (inZone) return inZone;
  }
  // "Sep 26, 2026": Date.parse reads it in the host's zone, so take its fields and place them in the offset.
  const en = Date.parse(v.replace(/(\d)(st|nd|rd|th)/, "$1"));
  if (!Number.isFinite(en)) return null;
  const local = new Date(en);
  return atOffset(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), offsetOf(opts));
}
