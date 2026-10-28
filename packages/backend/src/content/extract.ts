// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, isBoilerplateBody, stripBoilerplate, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, stripChromeHtml, trimTrailingChrome } from "./sanitize.ts";
import { markdownBody } from "./markdown.ts";
import { contentHash } from "./materials.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import * as cheerio from "cheerio";
import {originalBodyDefect} from "./body-quality.ts";

function checkExtractionRunning(): void {
  if (shutdownSignal.signal.aborted) throw new Error("worker shutting down between extraction stages");
}

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
}

// Measured 2026-10-06 on twelve live 中央气象台 warning pages: their whole body is 126–308 characters
// (发布单位 + 时刻 + 预警信号 + 预计), and `stripBoilerplate` removes nothing from them. A floor of 150
// dropped 5 of those 12 — genuine alerts stuck at `body_status='unconfirmed'`, and a body-less item gets
// no Chinese summary, so it can never enter the pool. 120 keeps the "not a stub" intent: the two guards
// together still refuse footer-only pages, because `isBoilerplateBody` needs 60 real characters after
// the footer is stripped.
const MIN_BODY_CHARS = 120;

export function readable(html: string, url: string): ExtractedBody | null {
  // Copernicus collapses narrative sections while keeping its bibliography expanded. Readability
  // can therefore select only references. Its explicit article sections contain the complete paper.
  if (/(^|\.)copernicus\.org$/i.test(new URL(url).hostname)) {
    const $=cheerio.load(html);
    const article=$('div.article').filter((_,el)=>$(el).children('#abstract').length>0).first();
    const sections=article.children().filter((_,el)=>/^(abstract|section\d+)$/.test($(el).attr('id')??''));
    if(sections.length>1){
      const body=$('<div></div>');sections.each((_,el)=>{body.append($(el).clone());});
      body.find('script,style,.triangleWrapper,.co-arrow-open,.co-arrow-closed').remove();
      body.find('.h1').each((_,el)=>{$(el).replaceWith(`<h2>${$(el).html()??''}</h2>`);});
      body.find('img[data-webversion]').each((_,el)=>{$(el).attr('src',$(el).attr('data-webversion')!);});
      // The publisher supplies an exact static equation beside MathML. Preserve it as an image;
      // sanitization and the translator's existing image shielding retain every symbol and layout.
      body.find('math').each((_,el)=>{
        const formula=$(el).parent();const picture=formula.find('svg image').first();
        const src=picture.attr('xlink:href')||picture.attr('href')||picture.attr('src');
        if(src)formula.replaceWith($('<img>').attr('src',new URL(src,url).href).attr('alt',$(el).text()));
        else $(el).replaceWith($('<code>').text($(el).text()));
      });
      body.find('.fig .caption').each((_,el)=>{$(el).replaceWith(`<figcaption>${$(el).html()??''}</figcaption>`);});
      body.find('.fig').each((_,el)=>{$(el).replaceWith(`<figure>${$(el).html()??''}</figure>`);});
      const files=new Set<string>();
      $('a[href]').each((_,el)=>{try{const u=new URL($(el).attr('href')!,url);if(u.origin===new URL(url).origin&&u.pathname.startsWith(new URL(url).pathname)&&/-\d{4}(?:-supplement)?\.pdf$/i.test(u.pathname))files.add(u.href);}catch{}});
      if(files.size){body.append('<h2>Full text and supplementary files</h2>');for(const href of files)body.append($('<p>').append($('<a>').attr('href',href).text(href.split('/').pop()!)));}
      return extractedBody(body.html()??'',url);
    }
  }
  // This journal keeps figures and appendices beside the text in interactive drawers. Readability
  // drops those drawers, including the actual research figures. Extract their content before it runs.
  if (/^(www\.)?ecologyandsociety\.org$/i.test(new URL(url).hostname)) {
    const $ = cheerio.load(html);
    const text = $(".article__text").first();
    if (text.length && text.text().trim().length >= MIN_BODY_CHARS) {
      const parts = [text.html() ?? ""];
      const figures: string[] = [];
      $(".article__figures .article__figure").each((_, el) => {
        const block = $(el);
        const full = block.find(".article__figure-full").first().clone();
        if (full.length) {
          full.find("script, style, meta, link, title").remove();
          // The publisher's CDN can cache an empty HTML response at the bare image URL. A stable
          // query keeps the same original image while avoiding that poisoned cache entry.
          full.find("img[src]").each((_, image) => {
            const src = new URL($(image).attr("src")!, url);
            src.searchParams.set("geohot", "original");
            $(image).attr("src", src.toString());
          });
          const caption = full.find("h1").first();
          const captionHtml = caption.html();
          caption.remove();
          figures.push(`<figure>${full.html() ?? ""}${captionHtml ? `<figcaption>${captionHtml}</figcaption>` : ""}</figure>`);
        } else {
          // Attachment links are content; the download/open icons and repeated preview images are UI.
          const attachment = block.find("figure").first().clone();
          attachment.find("img, script, style").remove();
          if (attachment.find("a[href]").length) figures.push($.html(attachment));
        }
      });
      if (figures.length) parts.push("<h2>Figures, Tables, &amp; Appendices</h2>", ...figures);
      // The structured selection is already the article; a second heuristic pass would remove its
      // figure drawer again. Reuse the normal sanitizer and image collection below instead.
      return extractedBody(parts.join(""), url);
    }
  }
  const { document } = parseHTML(html);
  let coverHtml = "";
  if (new URL(url).hostname.toLowerCase() === "news.mongabay.com") {
    // The cover is a CSS background outside Readability's body. Its explicit cover node avoids
    // unrelated recommendations and branding that generic page metadata can name.
    const style = document.querySelector(".article-cover-image__bg")?.getAttribute("style") ?? "";
    const match = /(?:^|;)\s*--cover-image-large\s*:\s*url\(\s*(['"]?)([^'"()\s]+)\1\s*\)/i.exec(style);
    if (match) {
      try {
        const imageUrl = new URL(match[2]!);
        if (imageUrl.protocol === "https:" && imageUrl.hostname === "imgs.mongabay.com" && !imageUrl.port && !imageUrl.username && !imageUrl.password) {
          const figure = document.createElement("figure");
          const image = document.createElement("img");
          image.setAttribute("src", imageUrl.href);
          figure.appendChild(image);
          coverHtml = figure.outerHTML;
        }
      } catch {
        // An invalid cover leaves the readable article intact.
      }
    }
  }
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  if (new URL(url).hostname.toLowerCase() === "news.mongabay.com") {
    const $ = cheerio.load(article.content, null, false);
    $("img[src]").each((_, image) => {
      try {
        if (/(^|\.)gravatar\.com$/i.test(new URL($(image).attr("src")!, url).hostname)) $(image).remove();
      } catch {
        // Other malformed images remain subject to the normal sanitizer.
      }
    });
    article.content = $.html();
  }
  return extractedBody(coverHtml + article.content, url);
}

function extractedBody(html: string, url: string): ExtractedBody | null {
  const clean = stripChromeHtml(trimTrailingChrome(sanitizeBody(html, url)));
  const text = stripBoilerplate(stripTags(clean));
  if(originalBodyDefect(url,clean,text))return null;
  if (text.length < MIN_BODY_CHARS || isBoilerplateBody(text)) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string }): Promise<ExtractedBody | null> {
  checkExtractionRunning();
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  if (!opts.allowJina) return null;
  checkExtractionRunning();
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject });
    // A real Markdown parser, not the four-regex approximation this used to be (upstream 3e36e48):
    // that one broke on headings without a preceding blank line, nested lists and tables. `markdownBody`
    // still ends in the same sanitize → trim pipeline, so the HTML whitelist is unchanged.
    const html = markdownBody(page.markdown, url);
    // Jina returns the whole rendered page, footer and all — measured 2026-10-06: 96 of the last 400
    // stored bodies began with 「国家气象中心 版权所有…未经授权禁止下载使用」. Strip the boilerplate,
    // and if nothing real is left, this page has no body (an unconfirmed item beats a footer item).
    const text = stripBoilerplate(stripTags(html));
    if(originalBodyDefect(url,html,text))return null;
    if (text.length < MIN_BODY_CHARS || isBoilerplateBody(text)) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    // 额度满了不是「这页没有正文」。原先这里 `if (error instanceof BudgetExceededError) return null`，
    // 而 null 在 `extractArticleBody` 那条路上就是 `body_status='unconfirmed'`——一次 jina 的 5 次/分钟
    // 窗口就能把当天所有等兜底的页面永久判成无正文（`waitsForPage` 只等 'pending'，再也不会回头看它们）。
    // 抛出去：`jobs/content.ts` 的抽取 handler 会按 retry 窗口排回去而不消耗条目的重试次数。
    throw error;
  }
}

/** Pages extraction can fetch: ordinary web pages (X posts, WeChat articles and video pages arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com|youtube\.com|youtu\.be)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null }[]>`
    SELECT id, url, body_status, revision, x_post FROM articles WHERE id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}` });
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null }[]>`SELECT title, excerpt FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
  });
  return "ok";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string): Promise<"ok" | "unconfirmed"> {
  checkExtractionRunning();
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [row.body_text ?? "", got.title ? `# ${got.title}` : "", got.text].filter(Boolean).join("\n\n");
    const hash = contentHash({ title, bodyText, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET title = ${title}, body_text = ${bodyText}, x_article = ${tx.json(got as never)}, body_status = 'ok',
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${title}, ${bodyText})`;
  });
  return "ok";
}

export { collapseWhitespace };
