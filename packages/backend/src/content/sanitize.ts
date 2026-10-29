// One body representation for the web page, Markdown export and full RSS: whitelisted HTML.
// External HTML is never executed; images keep their original src and are signed at read time.
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { stripBoilerplate } from "../lib/text.ts";
import { dedupeConsecutiveFigures } from "./body-quality.ts";

const ALLOWED_TAGS = [
  "p", "br", "hr", "h2", "h3", "h4", "h5", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "caption", "a", "img", "figure", "figcaption", "strong", "em", "b", "i", "u", "s", "del",
  "sup", "sub", "mark", "span", "dl", "dt", "dd", "picture", "video",
];

/** A class naming a promotion block (msr-promo, promo-box …), not text such as "promotion". */
const PROMO_CLASS = /(?:^|[-_])promo(?:$|[-_])/i;

/**
 * Promotions a site places inside its posts and rotates between loads (Microsoft Research puts a
 * different podcast or product box into each post of its feed). They are no part of the post, and
 * keeping them made every fetch look like a new version of the article.
 */
function dropPromotions(html: string): string {
  if (!/promo/i.test(html)) return html;
  const $ = cheerio.load(html, null, false);
  $("[class]")
    .filter((_, el) => ($(el).attr("class") ?? "").split(/\s+/).some((c) => PROMO_CLASS.test(c)))
    .remove();
  return $.html();
}

/**
 * Elements whose content is never article text: dropped with everything inside, where other unknown
 * tags are only unwrapped. A page's <template> blocks held hundreds of thousands of characters of
 * base64 that surfaced as paragraphs.
 */
const DROP_WHOLE = [
  "script", "style", "noscript", "textarea", "option", "iframe", "object", "embed", "applet", "form", "input", "select",
  "button", "label", "fieldset", "legend", "svg", "link", "meta", "base", "title", "head", "template", "audio",
  "map", "area", "frame", "frameset", "track", "source", "param",
  // MathML is unwrapped to its text; its LaTeX source and embedded markup are not text.
  "annotation", "annotation-xml", "mglyph",
];

/**
 * Some journals put the whole record page into the feed's `<content>` (measured 2026-10-16: 48 selected
 * full-text items in 30 days, all of them Copernicus — EGUsphere 29, ESSD 16). A reader then gets the
 * review legend, four subscription buttons, the "Metrics will be available soon." placeholder and the
 * author list four times, and the translate lane faithfully renders all of it in Chinese. Each rule is
 * anchored to the start of a block that *is* only that line: a real sentence beginning "Status of the
 * high-mountain environment…" must survive, so the pattern demands the colon and nothing else before it.
 */
const RECORD_PAGE_LINE = [
  /^status\s*[:：]/i,
  /^comment types\s*[:：]/i,
  /^[:：]?\s*report abuse$/i,
  /^received\s*[:：]/i,
  /^discussion (?:started|closed)\s*[:：]/i,
  /^latest update\s*[:：]/i,
  /^(?:article |related )?metrics\b.{0,40}$/i,
  /^[–—-]$/,
];

/**
 * The sentence a browser prints for a `<video>`/`<img>`/`<audio>` element it cannot play. Both ends anchored, and
 * only the standard continuation is allowed: without the `$` this ate real prose — "To view this video please
 * enable JavaScript is what the old kiosk printed for every visitor" (found by the review of 2026-10-16).
 * Exported because the wash script counts occurrences of this shape to decide whether a stored row changed.
 */
export const PLAYER_FALLBACK =
  /^to view this (?:video|image|audio) please enable javascript[,.]?(?: and consider upgrading to a web browser that supports html5 video)?$/i;
/** The loaded document's own API and the wrapper it returns for one node — helpers take these, because the `cheerio` namespace import is not callable. */
type Api = ReturnType<typeof cheerio.load>;
type Block = ReturnType<Api>;
/**
 * The link the fallback sentence ships with (video.js points at its own HTML5-support blurb). Part of the
 * template, so it does not make the block content — every other link or image does.
 */
const FALLBACK_LINK = /^https?:\/\/(?:[\w-]+\.)*videojs\.com\/html5-video-support\/?$/i;
/** A block that carries media or a real link is content even when it opens with that sentence: keep the whole block. */
const mediaOrLink = (at: Api, block: Block) =>
  block.find("img, video, source, audio, iframe, table").length > 0 ||
  block.find("a[href]").toArray().some((a) => !FALLBACK_LINK.test(at(a).attr("href") ?? ""));
/** The selector the empty/fallback sweep walks, and the count below measures — one list, so they cannot diverge. */
const CHROME_BLOCK_TAGS = "p, figcaption, figure, li";
/**
 * Is this block chrome: the player's fallback sentence standing alone, or nothing at all?
 * Shared by the sweep in `dropRecordPageChrome` and by `chromeMarks`, because a judge that measures a
 * different shape than the rule removes is how rows stayed dirty forever (2026-10-16, twice).
 */
const isChromeBlock = (at: Api, block: Block) => {
  const text = collapse(block.text());
  return (PLAYER_FALLBACK.test(text) && !mediaOrLink(at, block)) || (!text && !block.children().length);
};
/** A sourceless player the reader could ever see: not playable, not nested inside a playable one, no media link. */
const isDeadPlayer = (at: Api, player: Block) => {
  if (player.attr("src") || player.attr("poster") || player.find("source[src]").length) return false;
  if (player.parents("video").length) return false;
  return !player.find("a[href]").toArray().some((a) => MEDIA_FILE.test(at(a).attr("href") ?? ""));
};
/**
 * How many chrome shapes an HTML fragment holds. The wash script compares this before and after
 * `dropRecordPageChrome` instead of comparing bytes or tag counts, both of which cheerio's tag-closing can move
 * in the wrong direction (a NASA row: −2 tags for the shell, +10 tags added, judge said "unchanged" forever).
 */
export function chromeMarks(html: string): number {
  const $ = cheerio.load(html, null, false);
  let n = 0;
  $("video").each((_, el) => {
    if (isDeadPlayer($, $(el))) n++;
  });
  $(CHROME_BLOCK_TAGS).each((_, el) => {
    if (isChromeBlock($, $(el))) n++;
  });
  return n;
}

const FEED_URL = /\.(?:xml|rss|atom)(?:[?#]|$)/i;
/** Once the player cannot play, a link to the media file is the reader's only route to it: that is content, not chrome. */
const MEDIA_FILE = /\.(?:mp4|webm|ogv|ogg|m4v|mov|m3u8|mp3)(?:[?#]|$)/i;
/** Only a block that is one paragraph can *be* a "Status:" line; a whole list that begins with one is metadata. */
const RECORD_LINE_TAGS = new Set(["p", "h2", "h3", "h4", "h5", "blockquote"]);
/** A comma-separated run that never closes a sentence: the shape of an author list, not of prose. */
const isNameList = (text: string) => text.length >= 40 && text.includes(",") && !/[.。!?！？]$/.test(text);
/** How many identical copies of a block make it machine-generated furniture rather than a deliberate repeat. */
const REPEAT_AS_CHROME = 3;

export function dropRecordPageChrome(html: string): string {
  const $ = cheerio.load(html, null, false);
  // Repeats are counted before anything is dropped. A two-copy repeat in stored bodies was always content —
  // the same "Department of …, Universitas Brawijaya, Malang, Indonesia" under two different authors, the same
  // institution line under two papers — while the record page repeats its author list four times over.
  const copies = new Map<string, number>();
  const repeated = new Set<string>();
  $.root().children().each((_, el) => {
    if (el.type !== "tag" || !RECORD_LINE_TAGS.has(el.name)) return;
    const block = $(el);
    const text = collapse(block.text());
    if (!isNameList(text) || block.find("a, img, video, picture").length) return;
    const n = (copies.get(text) ?? 0) + 1;
    copies.set(text, n);
    if (n >= REPEAT_AS_CHROME) repeated.add(text);
  });
  const keptFirst = new Set<string>();
  // Judged only between siblings, and only over paragraph-shaped blocks. Running this against stored bodies
  // (2026-10-16) turned up both ways a broad traversal destroys content: Eur. J. Mineral. writes each mineral
  // record as `<ul><li><p>field</p></li>`, so parent and child hold the same characters and a descent through
  // both levels took one for a copy of the other and deleted half the field list; and Nature's TOC feed puts
  // Received/Accepted/Published/DOI in one `<ul>`, whose text begins with "Received:" — an anchored line rule
  // that also matched a container took the whole citation list with it.
  $.root().children().each((_, el) => {
    if (el.type !== "tag" || !RECORD_LINE_TAGS.has(el.name)) return;
    const block = $(el);
    const text = collapse(block.text());
    // A subscription button: a block with no words at all, only link(s) to a feed address wrapping the gif.
    const links = block.find("a[href]").toArray();
    if (!text && links.length && links.every((a) => FEED_URL.test($(a).attr("href") ?? ""))) {
      block.remove();
      return;
    }
    if (RECORD_PAGE_LINE.some((re) => re.test(text))) {
      block.remove();
      return;
    }
    // The player's fallback sentence standing on its own: `<p>` is not allowed inside the `<p>` a publisher
    // wraps a `<video>` in, so the parser lifts it out and the shell rule below never sees it (7 such rows
    // survived that rule on 2026-10-16). Never when the block carries media — a chart inside such a
    // paragraph is content, and dropping the block would drop the chart with it.
    if (isChromeBlock($, block)) {
      block.remove();
      return;
    }
    if (repeated.has(text)) {
      if (keptFirst.has(text)) block.remove();
      else keptFirst.add(text);
    }
  });
  // A player with nothing to play. Germany's DW writes its feed videos as `<video>` with no source, and the
  // browser's only output for that element is its fallback sentence — so the reader gets "To view this video
  // please enable JavaScript…" as body text (172 stored bodies on 2026-10-16, 4 of them already translated
  // into Chinese). The test is whether the element can play anything, never what the sentence says: prose
  // about JavaScript must survive.
  $("video").each((_, el) => {
    if (isDeadPlayer($, $(el))) $(el).remove();
  });
  // Removing the shell can leave the paragraph that held it with nothing in it (7 such rows measured on
  // the washed set the same evening). An empty block has no content at any depth — NASA nests the shell
  // inside a `<figure>` and the Guardian's empty paragraphs sit under a wrapper — so this pass is not
  // limited to root siblings, and it cannot eat prose: there is nothing to eat. `<figure>` and `<li>` go
  // with it because that is what the player and the dropped paragraphs leave behind, and both cost the
  // reader vertical space (`app.css`: `.prose figure{margin:1.5em 0}`) — 204 such rows on 2026-10-16.
  // `<td>`/`<th>` deliberately stay: an empty cell is a column, not a stray box.
  // The fallback sentence joins it at any depth (DW and NASA wrap it in a `<figure>`, where the root-sibling
  // pass above cannot reach it), but only that one sentence and only when the whole block is it: the other
  // anchored rules stay root-level on purpose, because Eur. J. Mineral. writes each record field as
  // `<li><p>Status: …</p></li>` and a deep traversal took whole field lists with it. A block carrying an
  // image or a link is never touched — dropping it would drop the chart with the sentence (both review
  // BLOCKERs of 2026-10-16 were this shape).
  // Swept inner-first (reversed preorder always visits a descendant before its ancestor), so a block
  // emptied by removing its child is collapsed in the same pass instead of being paid for twice.
  // Same predicate as `chromeMarks`, so the wash judge and the rule can never measure different shapes again.
  $("p, figcaption, figure, li")
    .get()
    .reverse()
    .forEach((el) => {
      if (isChromeBlock($, $(el))) $(el).remove();
    });
  return $.html();
}

export function sanitizeBody(html: string, baseUrl?: string): string {
  const cleaned = sanitizeHtml(dropPromotions(html), {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: DROP_WHOLE,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height", "title"],
      video: ["src", "poster", "width", "height"],
      code: ["class"],
      pre: ["class"],
      th: ["colspan", "rowspan", "align"],
      td: ["colspan", "rowspan", "align"],
      span: [],
    },
    allowedClasses: { code: [/^language-[\w-]+$/], pre: [/^language-[\w-]+$/, "bulletin-data"] },
    allowedSchemes: ["http", "https"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: true,
    transformTags: {
      h1: "h2",
      h6: "h5",
      div: (_tagName, attribs) => ({ tagName: "p", attribs }),
      section: "p",
      article: "p",
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, ...(attribs.href ? { href: resolveUrl(attribs.href, baseUrl) } : {}) },
      }),
      img: (tagName, attribs) => {
        const src = unwrapProxyUrl(attribs["data-src"] || attribs["data-original"] || attribs.src || "");
        return { tagName, attribs: { ...attribs, src: resolveUrl(src, baseUrl) } };
      },
      video: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, ...(attribs.poster ? { poster: resolveUrl(unwrapProxyUrl(attribs.poster), baseUrl) } : {}) },
      }),
    },
    // Empty paragraphs go in normalizeBlocks, which sees nested images: a frame only knows its direct
    // children, and a paragraph holding a linked chart (<p><a><img></a></p>) looked empty here.
    exclusiveFilter: (frame) =>
      (frame.tag === "img" && !frame.attribs.src) ||
      (frame.tag === "a" && !frame.text.trim() && !frame.mediaChildren?.length),
  });
  // Flattened first, then the record page is judged between siblings: the div-to-p transform above can leave
  // a paragraph nested inside a block that stands for the same text.
  return dedupeConsecutiveFigures(dropRecordPageChrome(normalizeBlocks(cleaned)));
}

const BLOCK_TAGS = new Set(["p", "h2", "h3", "h4", "h5", "ul", "ol", "li", "blockquote", "pre", "table", "figure", "hr", "dl", "picture", "video"]);

/**
 * Re-parses the sanitised HTML the way browsers do: a block element closes an open paragraph, so
 * containers turned into <p> (nested divs) no longer leave nested or empty paragraphs behind. Empty
 * paragraphs are dropped and loose top-level text is wrapped in its own paragraph.
 */
export function normalizeBlocks(html: string): string {
  const $ = cheerio.load(html, null, false);
  // Empty containers go here, at any depth, inner-first: this is the function every path ends with
  // (`sanitizeBody` and `stripChromeHtml` both call it), and dropping only `<p>` left the wrapper behind —
  // `<figure><p>责任编辑：王明</p></figure>` came back as `<figure></figure>`, which `app.css` gives
  // `margin:1.5em 0`, so the reader saw a gap and the row was paid to re-translate for nothing (review of
  // 2026-10-16). `<td>`/`<th>` stay: an empty cell is a column.
  $("p, figure, li")
    .get()
    .reverse()
    .forEach((el) => {
      const block = $(el);
      if (!block.text().trim() && !block.find("img, video, picture").length) block.remove();
    });
  const out: string[] = [];
  let run: string[] = [];
  let meaningful = false;
  const flush = () => {
    if (meaningful) out.push(`<p>${run.join("").trim()}</p>`);
    run = [];
    meaningful = false;
  };
  for (const node of $.root().contents().toArray()) {
    if (node.type === "tag" && BLOCK_TAGS.has(node.name)) {
      flush();
      out.push($.html(node));
    } else if (node.type === "text" || node.type === "tag") {
      run.push($.html(node));
      if ($(node).text().trim() || (node.type === "tag" && $(node).is("img, a:has(img), br") && node.name !== "br")) meaningful = true;
    }
  }
  flush();
  return out.join("").trim();
}

/**
 * Short blocks a news page puts after the article (TechCrunch ends in "Topics", "Subscribe for the
 * industry's biggest tech news", "Latest in AI"). Only headings and calls to action without a full
 * stop, only at the very end of an extracted page, one block at a time: an article's own sentences stay.
 */
const TRAILING_CHROME = [
  /^topics$/i, /^tags?$/i, /^latest in [\p{L}\s&-]{1,30}$/iu, /^latest (?:news|stories)$/i, /^most (?:popular|read)$/i,
  /^related (?:articles|posts|stories|content|reading|coverage)$/i, /^more (?:stories|articles|news)$/i, /^(?:keep reading|read next|up next)$/i,
  /^(?:you (?:might|may) also like|recommended(?: for you)?)$/i, /^(?:subscribe|sign up)\b.{0,80}$/i, /^share (?:this|on)\b.{0,40}$/i,
  /^follow us\b.{0,40}$/i, /^advertisement$/i,
];

export function trimTrailingChrome(html: string): string {
  const $ = cheerio.load(html, null, false);
  let blocks = $.root().children().toArray();
  let removed = false;
  while (blocks.length > 1) {
    const last = $(blocks[blocks.length - 1]!);
    const text = collapse(last.text());
    if (last.find("img, video, picture").length || /[.。!！?？:：]$/.test(text) || !TRAILING_CHROME.some((re) => re.test(text))) break;
    last.remove();
    blocks = blocks.slice(0, -1);
    removed = true;
  }
  return removed ? $.html() : html;
}

/**
 * 页面外壳混在正文元素里时（中新网把「发稿时间 + 来源：链接」单独排成一段、字号控件各占一段、
 * 编辑署名排在末尾），逐行删规则只在纯文本里管用，而读者看的是 HTML。线上实测存的正文长这样：
 * `<p>2026年10月06日 14:02　来源：<a …>中国新闻网</a></p><p><span></span>大字体</p><p><span></span>小字体</p>`。
 * 先整段删掉「只有时间行」的段（信源名在一个链接里，文本节点规则够不着），再对每个文本节点跑
 * `lib/text.ts` 那一处规则，最后交给 `normalizeBlocks` 收掉因此变空的段。
 */
const CHROME_ONLY_BLOCK = /^\s*\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}[:：]\d{2}\s*来源[：:]\s*\S{0,20}\s*$/;

/** 节点里前后那点空白是行内边界，不是脏东西：`at <a>NASA</a> said` 压成 `atNASA said` 就是改内容。 */
function cleanTextNode(data: string): string {
  const kept = /^\s*/.exec(data)?.[0] ?? "";
  const tail = /\s*$/.exec(data)?.[0] ?? "";
  const body = stripBoilerplate(data);
  return body ? kept + body + tail : "";
}

export function stripChromeHtml(html: string): string {
  const $ = cheerio.load(html, null, false);
  $("p, h2, h3, h4, h5, li, blockquote").each((_, el) => {
    // 和 `normalizeBlocks` 同一道判断：一段里还挂着图就不能整段删，时间行与图并排是真实存在的形状。
    if (CHROME_ONLY_BLOCK.test($(el).text()) && !$(el).find("img, video, picture").length) $(el).remove();
  });
  $.root()
    .find("*")
    .addBack()
    .each((_, el) => {
      // 代码块不动一行：`stripBoilerplate` 会删空行、并把连续空格压成一个，缩进和空行是代码自己的东西。
      if ($(el).is("pre") || $(el).parents("pre").length) return;
      $(el)
        .contents()
        .each((__, node) => {
          if (node.type === "text") node.data = cleanTextNode(node.data);
        });
    });
  return normalizeBlocks($.html());
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const OWN_PROXY = /^(?:https?:\/\/[^/?#]+)?\/api\/img-proxy\?/i;

/**
 * The image an address of our own image proxy stands for. Legacy bodies were saved with the proxy's
 * relative address (`/api/img-proxy?u=…&exp=…&sig=…`); resolved against the article's own site it
 * pointed nowhere. The source image is the `u` it wraps, signed again when a page is served.
 */
export function unwrapProxyUrl(src: string): string {
  const s = src.trim();
  if (!OWN_PROXY.test(s)) return src;
  const u = new URLSearchParams(s.slice(s.indexOf("?") + 1).replace(/&amp;/g, "&")).get("u");
  return u && /^https?:\/\//i.test(u) ? u : src;
}

function resolveUrl(href: string, base?: string): string {
  if (!href) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Plain paragraphs to HTML, for sources that only give text (X posts, translations). */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
