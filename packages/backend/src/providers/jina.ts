// Jina Reader (r.jina.ai): browser-rendered page text. Paid per request, reached through the egress
// proxy, always behind receipts and the per-minute/hour/day budget (any zero stops it).
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, rejectReceivedResponse, ProviderRejectedError } from "./receipts.ts";

export interface JinaPage {
  title: string | null;
  url: string | null;
  publishedTime: string | null;
  markdown: string;
}

export function parseJinaText(text: string): JinaPage {
  const header = text.split(/\nMarkdown Content:\n/)[0] ?? "";
  const body = text.includes("\nMarkdown Content:\n") ? text.split(/\nMarkdown Content:\n/).slice(1).join("\nMarkdown Content:\n") : text;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(header)?.[1]?.trim() ?? null;
  return { title: field("Title"), url: field("URL Source"), publishedTime: field("Published Time"), markdown: body.trim() };
}

/** The words a page says to a bot it does not want, instead of its text. */
const ANTI_BOT = /(enable\s+javascript|please\s+(?:log|sign)\s*in|access\s+denied|not\s+a\s+robot|robot\s+check|captcha|verify\s+you\s+are|抱歉|访问受限|安全验证)/i;

/**
 * Why an HTTP 200 is no article: nothing was rendered at all, or the whole document is a short wall.
 * Text that merely mentions a captcha is the article, so the wall only counts when there is nothing
 * else to read.
 */
export function unusableRendering(page: JinaPage): string | null {
  const md = page.markdown.trim();
  if (!md) return "empty markdown";
  if (md.length < 400 && ANTI_BOT.test(md)) return "anti-bot wall";
  return null;
}

/**
 * Reads a page through Jina. The receipt key is the target URL plus the day, so a same-day retry of an
 * article's body or detail reuses it. A listing is read afresh on every fetch (`perRead`): with the day
 * key each listing was read once a day and every later fetch saw the morning's page.
 */
export async function jinaRead(
  targetUrl: string,
  opts: { purpose: string; subject: string; format?: "markdown" | "html"; cacheToleranceSeconds?: number; perRead?: boolean },
): Promise<JinaPage & { receiptId: number; raw: string }> {
  const key = credential("collectors", "JINA_API_KEY");
  if (!key) throw new Error("JINA_API_KEY is not configured");
  const base = (credential("collectors", "JINA_BASE_URL") ?? "https://r.jina.ai").replace(/\/$/, "");
  // A listing whose freshness matters (xAI news) caps how old Jina's cached rendering may be.
  const tolerance: Record<string, string> = Number.isInteger(opts.cacheToleranceSeconds) && opts.cacheToleranceSeconds! >= 0 ? { "x-cache-tolerance": String(opts.cacheToleranceSeconds) } : {};
  const now = new Date().toISOString();
  const day = opts.perRead ? now : now.slice(0, 10);
  const receipt = await paidRequest(
    { service: "jina", model: null, purpose: opts.purpose, subject: opts.subject, identity: { url: targetUrl, day, format: opts.format ?? "markdown" }, requestSummary: { url: targetUrl } },
    async () => {
      const res = await guardedFetch(`${base}/${targetUrl}`, {
        headers: { authorization: `Bearer ${key}`, "x-return-format": opts.format ?? "markdown", accept: "text/plain", ...tolerance },
        timeoutMs: 60_000,
        maxBytes: 6 * 1024 * 1024,
      });
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 422 || res.status === 400) {
        throw new ProviderRejectedError(`jina HTTP ${res.status}`, res.status, false);
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`jina HTTP ${res.status}`, res.status, true);
      const text = res.text();
      // Billed in tokens; estimated at about ¥0.36 per million (a recharge-pack price). Without the usage
      // header nothing is guessed.
      const tokens = Number(res.headers.get("x-usage-tokens")) || null;
      const cost = tokens ? { amount: (tokens / 1e6) * 0.36, currency: "CNY", basis: "estimated" as const } : null;
      return { response: { text: text.slice(0, 2_000_000), status: res.status }, requestId: res.headers.get("x-request-id"), usage: { bytes: res.body.length, tokens }, cost };
    },
  );
  const raw = String((receipt.response as { text?: string })?.text ?? "");
  const page = parseJinaText(raw);
  // A paid answer that carries no page is not a result: left as `received` it is reused for the rest of
  // the day (that is what the day key is for), and the article silently loses its title and its date for
  // 24 hours. Fail the receipt so the next attempt may pay for a real rendering, and say so out loud.
  const broken = unusableRendering(page);
  if (broken) {
    await rejectReceivedResponse(receipt.receiptId, `jina rendering unusable (${broken})`);
    throw new ProviderRejectedError(`jina returned no page for ${targetUrl} (${broken})`, 200, true);
  }
  return { ...page, receiptId: receipt.receiptId, raw };
}
