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
