// 浏览器要照做的地址，只在这一处判定 scheme。
//
// 为什么需要它：`<a href>` 认的不是"路径"而是"任何 scheme"，`href="javascript:…"` 会被执行，执行现场
// 是发出这一页的那个源——后台那一页尤其值钱，管理员正带着自己的会话停在那里。给地址的那串字符未必是
// 我们写的：反馈的 `page_url` 是匿名访客提交的（`packages/backend/src/operations/feedback.ts` 只做
// trim 和截断），条目页的原文链接来自采集器。所以前端这一层不假设上游已经筛过：判定与后端
// `packages/backend/src/lib/url.ts` 的 `normalizeUrl()` 同口径（不是 http/https 就不算地址），
// 这里是复刻判定，不是引用服务端实现——前端不引后端的包（AGENTS.md「前端只通过 HTTP 读 apps/api」）。
//
// 这一模块刻意不 import `public-path.ts`：`publicPath()` 管的是前缀，`import.meta.env` 只有打包后才有，
// 而这里的函数要在纯 Node 的测试里跑得动。前缀与 scheme 是两类判定，调用处各自负责。
//
// 拿到 `string | null`，换一个"能安全写进 href 的值或 null"。null 就渲染成纯文本，别猜。

/** 会改变 scheme 判定的字符：控制字符与空白会被 URL 解析器悄悄吃掉（`java\nscript:` 就是 `javascript:`）。 */
function hasHiddenChars(value: string): boolean {
  return /[\u0000-\u0020\u007f]/.test(value);
}

function isHttpScheme(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * An absolute `http(s)` address, or `null`. This is the only form that may be handed to an `<a href>`
 * when the string came from somebody else — a visitor's `page_url`, a scraped source's `url`.
 */
export function safeExternalHref(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || hasHiddenChars(trimmed)) return null;
  try {
    return isHttpScheme(new URL(trimmed)) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 可以原样交给浏览器的地址：站内绝对路径、`#片段`、`?查询`，或者绝对 http(s)。
 * `//host` 不算站内（协议相对，会走到站外）；带别的 scheme 的也不算。
 */
export function isSafeSitePath(value: string): boolean {
  if (!value || hasHiddenChars(value)) return false;
  if (value.startsWith("//")) return false;
  if (/^[a-z][a-z\d+-.]*:/i.test(value)) {
    try {
      return isHttpScheme(new URL(value));
    } catch {
      return false;
    }
  }
  return value.startsWith("/") || value.startsWith("#") || value.startsWith("?");
}
