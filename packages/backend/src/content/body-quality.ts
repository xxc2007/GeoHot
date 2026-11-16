import { load } from "cheerio";
import { stripBoilerplate, stripReaderChrome, stripConsentWall, isTemplateShell } from "../lib/text.ts";

export const BODY_QUALITY_RULE_VERSION = "2026-11-16.2";

export type BodyStatus = "ok" | "defect";

export interface BodyQualityResult {
  status: BodyStatus;
  /** Machine-readable defect reasons. Empty when status=ok. */
  reasons: string[];
  ruleVersion: string;
}

/** Exact adjacent figure copies are responsive/carousel duplicates, not new illustrations. */
export function dedupeConsecutiveFigures(html: string): string {
  const figures = [...html.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/g)];
  let previous: RegExpMatchArray | undefined;
  let cursor = 0;
  let out = "";
  for (const figure of figures) {
    const start = figure.index!;
    const end = start + figure[0].length;
    if (previous && figure[0] === previous[0] && !html.slice(previous.index! + previous[0].length, start).trim()) {
      out += html.slice(cursor, start);
      cursor = end;
    }
    previous = figure;
  }
  return cursor ? out + html.slice(cursor) : html;
}

/** Official weather prose is not code; both English and Spanish bulletins retain data shielding. */
export function isNhcProseBulletin(url: string, text: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ["nhc.noaa.gov", "www.nhc.noaa.gov"].includes(host)
      && /\b[A-Z]{4}\d{2}\s+KNHC\b/.test(text)
      && /NWS National Hurricane Center|Centro Nacional de Huracanes/i.test(text);
  } catch { return false; }
}

/** Conservative hard failures, not a language-quality score or an automatic mojibake rewrite. */
export function translationTextDefect(text: string): string | null {
  if (/\uFFFD/.test(text)) return "replacement-character";
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return "control-character";
  if (/⟦G\d+⟧/.test(text)) return "unrestored-protected-token";
  if (/(\p{L})\1{24,}/u.test(text)) return "repeated-character";
  if ((text.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length >= 4) return "literal-unicode-escapes";
  return null;
}

/**
 * Short-bulletin exemption: a cleaned body of 20–79 real chars is a real short bulletin (earthquake
 * measurement, NHC advisory, government one-liner) when it either shares bigrams with the title or
 * carries structured time/location/magnitude/announcement signals. Cookie walls, template shells and
 * 10-char placeholders are NOT exempt — they are caught by the earlier hard-failure branches.
 */
function looksStructuredShortBulletin(optsTitle: string | undefined, body: string): boolean {
  if (optsTitle && optsTitle.length >= 6) {
    const titleBigrams: string[] = [];
    for (let i = 0; i < optsTitle.length - 1; i++) titleBigrams.push(optsTitle.slice(i, i + 2));
    const hits = titleBigrams.filter((bg) => body.includes(bg)).length;
    if (hits >= Math.max(2, Math.floor(titleBigrams.length * 0.2))) return true;
  }
  const hasTime = /\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{2}|\b(?:UTC|GMT|JST|EST|HKT|CST)\b/i.test(body);
  const hasMagnitude = /\d+(?:\.\d+)?\s*(?:级|Magnitude|mb|M\s?\d)/i.test(body);
  const hasPlaceEvent = /(?:省|市|县|州|岛|海|湾|洋|山|河)/.test(body) && /(?:震|雨|风|潮|洪|雪|雾|涝|旱|灾)/.test(body);
  const hasAnnouncement = /(正式测定|本报讯|消息|公告|通报|快讯|Advisory|Hurricane|Storm|Rainfall|Warning|Bulletin|KNHC|NHC)/i.test(body);
  return (hasTime && (hasMagnitude || hasPlaceEvent || hasAnnouncement)) || hasMagnitude || hasAnnouncement;
}

/**
 * Full body quality classification. Returns status=ok when the body looks like a real article;
 * status=defect with machine-readable reasons otherwise. Callers persist {status, reasons, ruleVersion}.
 *
 * Rules (conservative — no keyword-only kills):
 *  - consent-wall: the first 600 chars are entirely Cookie/privacy consent boilerplate
 *  - reader-chrome-only: after stripping reader UI, nothing real remains
 *  - template-shell: ≥3 unrendered {{placeholders}}
 *  - too-short: <20 real chars after cleaning; 20–79 chars pass when they look like a structured short bulletin
 *  - title-body-mismatch: title shares <2 bigrams with body
 *  - source-feed-teaser: known teaser signatures (Mongabay etc.)
 *  - source-references-only: scientific references list without narrative
 */
export function classifyBodyQuality(
  url: string,
  html: string,
  text: string,
  opts: { title?: string } = {},
): BodyQualityResult {
  const reasons: string[] = [];
  let host = "";
  try { host = new URL(url).hostname; } catch { /* unknown host — still classify text */ }

  // Clean reader chrome and consent wall first.
  // Check template shell on the RAW text first — stripBoilerplate removes {{...}} placeholders.
  const rawIsTemplateShell = isTemplateShell(text);
  const cleaned = stripConsentWall(stripReaderChrome(stripBoilerplate(text)));

  // 1. Template shell FIRST — even a short skeleton is a skeleton, not a real short bulletin.
  if (rawIsTemplateShell) reasons.push("template-shell");

  const realChars = cleaned.replace(/\s+/g, "").length;

  // 2. Consent wall: check the ORIGINAL text's leading chars (before stripping) for consent action.
  //    stripConsentWall removes the wall, so the cleaned text won't contain "同意" anymore.
  const rawHead200 = text.slice(0, 200);
  const consentAction = /我同意|同意并继续|继续浏览即表示您同意|Accept\s+All|I\s+Agree|允许所有|Accept\s+All\s+Cookies/i.test(rawHead200);
  if (consentAction) reasons.push("consent-wall-only");

  // 3. Too short. Hard floor at 20 real chars (10-char placeholders stay defect). 20–79 chars are
  //    exempt when they look like a structured short bulletin; cookie walls / template shells are
  //    already flagged above and stay defect regardless of length.
  if (!reasons.includes("template-shell") && realChars < 20) {
    reasons.push("too-short");
  } else if (!reasons.includes("template-shell") && realChars < 80 && !looksStructuredShortBulletin(opts.title, cleaned)) {
    reasons.push("too-short");
  }

  // 4. Title-body mismatch (only when a title is provided and body has substance).
  if (opts.title && opts.title.length >= 8 && realChars >= 80) {
    const titleBigrams = new Set<string>();
    for (let i = 0; i < opts.title.length - 1; i++) titleBigrams.add(opts.title.slice(i, i + 2));
    let overlap = 0;
    for (const bg of titleBigrams) if (cleaned.includes(bg)) overlap++;
    if (overlap / titleBigrams.size < 0.15) reasons.push("title-body-mismatch");
  }

  // 5. Known source-specific defects.
  if (/(^|\.)mongabay\.com$/i.test(host) && /(?:…|\.{3})\s*(?:This article was originally published on Mongabay|本文原发表于\s*Mongabay)[.。\s]*$/i.test(text)) {
    reasons.push("source-feed-teaser");
  }
  let scientific = false;
  try {
    const u = new URL(url);
    scientific = /(^|\.)copernicus\.org$/i.test(u.hostname) || (/^doi\.org$/i.test(u.hostname) && /^\/10\.5194\//.test(u.pathname));
  } catch { /* skip */ }
  if (scientific) {
    const start = cleaned.trim().replace(/^References\s*:?\s*/i, "");
    const citation = /^[\p{Lu}][\p{L}'’.-]+,\s*(?:[A-Z]\.\s*){1,5}/u.test(start);
    const narrative = [...html.matchAll(/<h[2-5]\b[^>]*>([\s\S]*?)<\/h[2-5]>/gi)].some((m) => /Abstract|Introduction|Method|Result|Discussion|Conclusion/i.test(load(m[1]!, null, false).root().text()));
    if (citation && (cleaned.match(/doi\.org\//g)?.length ?? 0) >= 3 && !narrative) reasons.push("source-references-only");
  }

  // 6. Boilerplate-only (after cleaning, nothing real left). Structured short bulletins are exempt.
  const isShortBulletin = realChars >= 20 && realChars < 80 && looksStructuredShortBulletin(opts.title, cleaned);
  if (realChars < 60 && !reasons.includes("too-short") && !isShortBulletin) reasons.push("boilerplate-only");

  return {
    status: reasons.length > 0 ? "defect" : "ok",
    reasons,
    ruleVersion: BODY_QUALITY_RULE_VERSION,
  };
}

/**
 * Positive extraction failures, not a character-count approximation of article completeness.
 * Returns the first defect reason (string) for backward compatibility, or null.
 * New code should use classifyBodyQuality() for the full reasons list.
 */
export function originalBodyDefect(url: string, html: string, text: string): string | null {
  const r = classifyBodyQuality(url, html, text);
  return r.reasons[0] ?? null;
}
