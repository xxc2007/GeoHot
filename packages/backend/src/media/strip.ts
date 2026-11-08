/**
 * 2026-11-08 现场：`media.prepare` 累计 1,792 条失败、只有 1,053 条成功，失败原因几乎都是
 * 「N rendition failure(s)」——源站图片从国内取不到（BBC/路透的 CDN 超时、防盗链）。
 * `packages/backend/src/media/prepare.ts` 的判据是 `ready = failed === 0`，于是正文里只要有一张
 * 取不到的图，这篇稿子就永远停在「媒体未就绪」，读者一条也看不到。
 *
 * 这里的取舍：取不到的图本来也显示不出来，与其整篇不发，不如把取不到的那几张 `<img>` 从正文里摘掉，
 * 让读者看到一篇完整的、没有坏图的短文；仍然取得到的图一张不动。
 */

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// 一次扫完所有实体：链式 replace 会把 `&amp;quot;` 解成 `"`（CodeQL js/double-escaping 也报了这一点），
// 而这里只需要把 src 里的 `&amp;` 还原成 `&` 才能与取图时用的地址对上。
const ENTITIES: Record<string, string> = { amp: "&", "#38": "&", quot: '"', "#39": "'", apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(amp|#38|quot|#39|apos);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/** 取出 `<img>` 标签的 src（已解开实体），没有 src 时返回 null。 */
export function imageSourceOf(tag: string): string | null {
  const match = SRC_ATTR.exec(tag);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? "";
  const src = decodeEntities(raw).trim();
  return src ? src : null;
}

/**
 * 删掉 src 命中的 `<img>` 标签，其余字节原样保留（不重排、不补空格）。
 * `urls` 用原样字符串比较，调用方传的就是正文里出现过的地址。
 */
export function stripImageSources(html: string, urls: readonly string[]): { html: string; removed: number } {
  if (!html || urls.length === 0) return { html, removed: 0 };
  const drop = new Set(urls);
  let removed = 0;
  const next = html.replace(IMG_TAG, (tag) => {
    const src = imageSourceOf(tag);
    if (!src || !drop.has(src)) return tag;
    removed += 1;
    return "";
  });
  return { html: removed > 0 ? next : html, removed };
}

/**
 * 一张图为什么没取到，决定要不要跳过它（站长 2026-11-08 选 A）：
 * - `refused`：源站自己拒绝（403/404/410/451）。谁都取不到，读者也看不到，跳过这张是唯一合理的处置；
 * - `transient`：超时、连接被掐、5xx——换个时间或换台出口机器就能取到，严格模式继续重试，不跳。
 * 判据只看取图这一层抛出来的消息（`packages/backend/src/media/images.ts` 里是 `upstream <status>`）。
 */
export function classifyRenditionFailure(message: string): "refused" | "transient" {
  return /upstream (403|404|410|451)\b/.test(message) ? "refused" : "transient";
}
