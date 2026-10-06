export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number, ellipsis = "…"): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("").trimEnd() + ellipsis;
}

export function stripTags(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'"),
  );
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/**
 * 页脚与版权话术——不是正文。站长 2026-10-06 明确要求：他的信息里只留核心内容。
 * 线上实测（近 400 条 `body_status=ok` 的正文）有 96 条（24%）开头就是
 * 「国家气象中心 版权所有 Copyright©2009-2026 本站所刊登的信息、数据和各种专栏材料，未经授权禁止下载使用…」，
 * 那是 Jina 兜底把整页文字（含页脚）当正文取了回来。这一条规则只写在这里，抽取、入库、喂模型、
 * 中文兜底四处都读它，不再各写一份。
 */
const BOILERPLATE_LINE =
  /^\s*(?:【?(?:版权|免责|声明|免责声明)】?|(?:国家|本站)?[^\n]{0,24}版权所有|Copyright\b|©\s*\d{4}|.*未经授权(?:禁止|不得).+|凡本网注明.*|转载请注明出处|ICP备\d+[^\n]{0,12}号|违法和不良信息举报电话[^\n]*|网站简介|联系我们|关于我们|技术支持[：:][^\n]*|主办[：:][^\n]*|承办[：:][^\n]*|All rights reserved)\b.*$/i;

/** 同一批话术出现在一整行里时（`stripTags` 会把换行折成空格），按片段删。 */
const BOILERPLATE_SEGMENT =
  /[^。；;\n]{0,40}版权所有[^。；;\n]{0,120}|Copyright[^。；;\n]{0,120}|未经授权(?:禁止|不得)[^。；;\n]{0,60}|凡本网注明[^。；;\n]{0,120}|转载请注明出处|ICP[备证]\d+[^\n]{0,16}号|违法和不良信息举报电话[^\n]{0,24}|All rights reserved|【?免责声明】?[^\n]{0,60}|技术支持[：:][^\n]{0,40}/gi;

/** 逐行、再按片段删掉页脚/版权话术，保留正文。 */
export function stripBoilerplate(text: string): string {
  if (!text) return "";
  const byLine = text
    .split("\n")
    .filter((line) => line.trim() && !BOILERPLATE_LINE.test(line.trim()))
    .join("\n");
  return byLine.replace(BOILERPLATE_SEGMENT, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * 整段基本就是页脚：删掉话术之后剩下的太少，不值得当正文。
 * 判定用「删完还剩多少」而不是「匹配到几句」——一篇真稿子也会带一句版权声明。
 */
export function isBoilerplateBody(text: string, minRealChars = 60): boolean {
  if (!text) return true;
  return stripBoilerplate(text).replace(/\s+/g, "").length < minRealChars;
}
