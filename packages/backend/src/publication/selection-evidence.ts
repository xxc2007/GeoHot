import { load } from 'cheerio';

/** Source material only: generated summaries, scores and translations cannot prove their own evidence.
 * This is a minimum evidence hold, not a factual accuracy or source licence assessment.
 */
function content(value: unknown): string {
  if (typeof value !== 'string') return '';
  const $ = load(value, {}, false);
  $('script,style,noscript,template').remove();
  return $.root().text().normalize('NFKC').replace(/https?:\/\/\S+/giu, '')
    .replace(/(?:^|\s)@[A-Za-z0-9_]+/gu, '')
    .replace(/(?:read\s+more|view\s+full\s+(?:article|text)|点击(?:阅读|查看)全文|阅读全文)/giu, '')
    .replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase('en-US');
}

export function hasSelectionEvidence(input: { title: string; bodyStatus: string; bodyText: string | null; excerpt: string | null; xPost: unknown }): boolean {
  const headline = content(input.title);
  for (const value of [input.excerpt, input.bodyStatus === 'ok' ? input.bodyText : null]) {
    const text = content(value);
    // A repeated, HTML-wrapped or shortened headline adds no separate source evidence.
    // No arbitrary word count: a short factual alert may contain all the available evidence.
    if (!/\p{L}/u.test(text) || (headline && headline.includes(text))) continue;
    if (/\p{L}/u.test(headline ? text.split(headline).join('') : text)) return true;
  }
  // A post's own text is original material, even when the collector also uses it as the title.
  // A bare article link or wrapper is not. A quoted post retains its separate attribution.
  if (input.xPost && typeof input.xPost === 'object' && !Array.isArray(input.xPost)) {
    const post = input.xPost as Record<string, unknown>;
    const quote = post.quoted && typeof post.quoted === 'object' ? post.quoted as Record<string, unknown> : {};
    for (const value of [post.text, quote.text]) {
      const text = content(value);
      if (/\p{L}/u.test(text)) return true;
    }
  }
  return false;
}
