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

/** What parsePublishedAt reads a value against: whose offset, and what unit the number is in. */
export interface PublishedAtOptions {
  utcOffset?: string | null;
  unit?: string | null;
  /** How a numeric date whose year comes last orders its day and month: "dmy" or "mdy". */
  dateOrder?: string | null;
}

/** The two date settings a source carries in its config, as the collectors hand them over. */
export interface DateConfig {
  publishedAtUtcOffset?: string | null;
  publishedAtDateOrder?: string | null;
}

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

/** The last day a calendar month really has (month is 1-based; February follows the year). */
export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * A numeric date that puts the year last: 07.10.2026 or 07/10/2026. Nothing in the value says which of the
 * first two numbers is the day, and the two readings are three months apart — Date.parse has always
 * answered with the American order, which on a European feed prints a wrong date where a reader sees it.
 * So the order comes from the source (publishedAtDateOrder) and is never assumed: with no declaration the
 * value gets no date, which is what "no date" is for. A declared order the value itself contradicts (a
 * month 31, a February 31) is no date either, because that declaration is not describing this feed.
 * Returns undefined when the value is not this shape at all, so the caller keeps looking. Because the
 * order is only ever read from the declaration, a changelog heading like "1.2.2026" on a feed whose
 * operator declared "dmy" will still read as a date — that declaration is the operator's own statement
 * about this source, which is why the key is off unless a measured feed actually prints the order.
 */
function fromYearLast(v: string, opts: PublishedAtOptions, utcOffset: string): Date | null | undefined {
  // The time may follow the day with a space, a T, or " - ", which is how a Drupal feed writes it
  // ("mer 07/10/2026 - 10:13"); a bare day is midnight in the source's own offset. The leading group is a
  // boundary, not a capture: "2026-10-07" must not be read as a year-last date hiding inside it.
  const m = /(?:^|[^\d])(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)(?:(?:[T ]|\s+-\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) return undefined;
  const dayFirst = opts.dateOrder === "dmy" ? true : opts.dateOrder === "mdy" ? false : null;
  if (dayFirst === null) return null;
  const day = dayFirst ? Number(m[1]) : Number(m[2]);
  const month = dayFirst ? Number(m[2]) : Number(m[1]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  // A zone the value carries itself ("07/10/2026 12:00:00+02:00") outranks the source's declared offset:
  // it is the moment the feed wrote. An abbreviation is not — V8's table is only consulted by the branch
  // below, so a year-last value with "EST" is placed in the source's offset, which can be hours off but
  // never months, and no live feed is known to write that combination.
  const zone = /(Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT)$/i.exec(v.trim());
  const inZone = zone ? /^(GMT|UTC|UT|Z)$/i.test(zone[1]!) ? "+00:00" : zone[1]!.replace("GMT", "+00:00") : utcOffset;
  return atOffset(year, month, day, m[4] ?? "0", m[5] ?? "0", m[6] ?? "0", inZone!);
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
 * is taken apart and placed in the source's offset. A date whose year comes last is read only when the
 * source declares its day-and-month order, and a zone spelled as an abbreviation is kept as the value's
 * own. Null means the source gave no usable date; an Invalid Date never leaves this function.
 */
export function parsePublishedAt(value: unknown, opts: PublishedAtOptions = {}): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const unit = opts.unit ?? "";
  if (unit === "epoch_ms" || unit === "epoch_s") return fromEpoch(value, unit);
  if (unit === "yyyymmdd") return fromYmd(value);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? fromEpoch(value, "epoch_ms") : null;

  const v = String(value).replace(/星期[一二三四五六日天]/, "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  // One published moment per value. "03/04/2026-07/10/2026" is a range and "…v1.2.2026…" is a sentence;
  // picking either date out of them would put a number on the page that the source never attached to this
  // item, so an ambiguous value gets no date instead. Only year-shaped groups count — a trailing "+0200"
  // is a zone, not a second year.
  if ((v.match(/(?<!\d)(?:1[89]|2[01])\d{2}(?!\d)/g) ?? []).length > 1) return null;
  // Before the zone shortcuts: with a year-last date and a zone both present, Date.parse reads the
  // American month/day order and the zone branch would return that wrong day before anything else ran.
  const yearLast = fromYearLast(v, opts, offsetOf(opts));
  if (yearLast !== undefined) return yearLast;
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
  // A zone written as an abbreviation ("Fri, 09 Oct 2026 12:00:00 EST") is still the value's own zone: the
  // engine resolves it, so reading that instant back in the host's zone and placing it in the source's
  // offset would apply a zone twice. Whether the token carried information is proved by removing it — if
  // the instant moves, the engine had read it. The answer comes out the same while host and source share
  // an offset, which is why six live feeds showed nothing: the box runs at +08:00 and none declares another.
  const abbr = /^([\s\S]*\d{1,2}:\d{2}(?::\d{2})?)\s+([A-Za-z]{2,4})$/.exec(v);
  if (abbr) {
    const withZone = Date.parse(v);
    if (Number.isFinite(withZone) && withZone !== Date.parse(abbr[1]!)) return new Date(withZone);
  }
  // "Sep 26, 2026": Date.parse reads it in the host's zone, so take its fields and place them in the offset.
  const en = Date.parse(v.replace(/(\d)(st|nd|rd|th)/, "$1"));
  if (!Number.isFinite(en)) return null;
  const local = new Date(en);
  return atOffset(local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), offsetOf(opts));
}
