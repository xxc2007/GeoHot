// Minimal Markdown → HTML for our own static site copy (legal pages, about, agent guide).
// Trusted input only: never used for third-party content.
import { isSafeSitePath } from "./safe-url.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string, site: string): string {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    // 这份文案是自己写的，但写出来的地址仍然只该是 http(s) 或站内路径：scheme 在这里再判一次
    // （lib/safe-url.ts）——`javascript:` 放进 `<a href>` 就会在读者这一页上执行，defence in depth
    // 在这种地方是免费的。认不出的地址只留文字，不编一个能点的。
    // 判的是 esc() 之后的那一串：引号已经写成 `&quot;`，属性不会被它截断。
    if (!isSafeSitePath(href)) return text;
    // A link to this site's own address becomes an in-site path; any other address opens in a new tab.
    const own = href === site || href.startsWith(`${site}/`);
    const external = /^https?:\/\//.test(href) && !own;
    const h = own ? href.slice(site.length) || "/" : href;
    return `<a href="${h}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
  });
  // Bare URLs.
  out = out.replace(/(^|[\s（(])((?:https?:\/\/)[^\s<）)]+)/g, (_m, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return out;
}

export function slugifyHeading(text: string, i: number): string {
  return `s${i + 1}`;
}

export interface RenderedCopy {
  html: string;
  outline: Array<{ id: string; text: string }>;
}

/** `site` is the site's own address (seo.ts siteUrl()), so links to it stay on the site. */
export function renderMarkdown(md: string, site: string): RenderedCopy {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  const outline: RenderedCopy["outline"] = [];
  let i = 0;
  let h = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      const id = slugifyHeading(text, h++);
      if (level === 2) outline.push({ id, text });
      html.push(`<h${level} id="${id}">${inline(text, site)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      html.push(`<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c, site)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, site)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      html.push(`<blockquote><p>${inline(buf.join(" "), site)}</p></blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.．]\s+/.test(line)) {
      const ordered = /^\s*\d+[.．]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]!) || /^\s*\d+[.．]\s+/.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i]!;
        if (/^\s{2,}\S/.test(l) && !/^\s*[-*]\s+/.test(l) && !/^\s*\d+[.．]\s+/.test(l)) items[items.length - 1] += ` ${l.trim()}`;
        else items.push(l.replace(/^\s*(?:[-*]|\d+[.．])\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((it) => `<li>${inline(it, site)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{2,4}\s|\||>|\s*[-*]\s|\s*\d+[.．]\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    html.push(`<p>${inline(para.join(""), site)}</p>`);
  }
  return { html: html.join("\n"), outline };
}

export interface CopyDocument {
  title: string;
  meta: Record<string, string>;
  intro: string | null;
  body: string;
}

/**
 * Splits a page copy file (industry/pages/) into its page parts: the first heading (title), the meta table,
 * the page-top statement (页首说明) and the verbatim body starting at the first "## " section.
 */
export function parseCopyFile(md: string, firstSection = /^## /m): CopyDocument {
  const title = (/^#\s+(.+)$/m.exec(md)?.[1] ?? "").replace(/（现行版）|（现网）/g, "").trim();
  const meta: Record<string, string> = {};
  for (const m of md.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)) {
    if (m[1] !== "项" && !/^-+$/.test(m[1]!)) meta[m[1]!] = m[2]!;
  }
  const introMatch = /页首说明：\s*\n+((?:>.*\n?)+)/.exec(md);
  const intro = introMatch ? introMatch[1]!.replace(/^>\s?/gm, "").replace(/\n/g, "").trim() : null;
  const start = md.search(firstSection);
  return { title, meta, intro, body: start >= 0 ? md.slice(start) : md };
}
