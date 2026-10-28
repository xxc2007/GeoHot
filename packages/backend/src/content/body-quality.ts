import {load} from 'cheerio';
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

/** Positive extraction failures, not a character-count approximation of article completeness. */
export function originalBodyDefect(url:string, html:string, text:string):string|null {
  let host='';try{host=new URL(url).hostname;}catch{return null;}
  if (/(^|\.)mongabay\.com$/i.test(host) && /(?:…|\.{3})\s*(?:This article was originally published on Mongabay|本文原发表于\s*Mongabay)[.。\s]*$/i.test(text)) return 'source:feed-teaser';
  let scientific=false;
  try {const u=new URL(url);scientific=/(^|\.)copernicus\.org$/i.test(u.hostname)||(/^doi\.org$/i.test(u.hostname)&&/^\/10\.5194\//.test(u.pathname));}catch{return null;}
  if(!scientific)return null;
  const start=text.trim().replace(/^References\s*:?\s*/i,'');
  const citation=/^[\p{Lu}][\p{L}'’.-]+,\s*(?:[A-Z]\.\s*){1,5}/u.test(start);
  const narrative=[...html.matchAll(/<h[2-5]\b[^>]*>([\s\S]*?)<\/h[2-5]>/gi)].some(m=>/Abstract|Introduction|Method|Result|Discussion|Conclusion/i.test(load(m[1]!,null,false).root().text()));
  return citation && (text.match(/doi\.org\//g)?.length??0)>=3 && !narrative ? 'source:references-only' : null;
}
