// Server half of the usage panel. Lives in its own module because a `.server` import inside a file
// that also ships a client component is rejected by the router build — and the loader must be able to
// reach `adminGet` without dragging session handling into the browser bundle.
import { beijingToday, usageDate, usageMonth } from "@aihot/contracts/usage-date";
import { adminGet } from "../../../lib/admin.server";
import type { Usage } from "./usage";

/** Hard deadline: the loader must resolve (success or error), so the page leaves its loading state. */
export async function loadUsage(request: Request, timeoutMs = 15_000): Promise<Usage> {
  const q = new URL(request.url).searchParams;
  const p = new URLSearchParams();
  if (q.has("date") && !usageDate(q.get("date") ?? undefined)) throw new Response("日期无效或尚未到来，请选择有效日期。", { status: 400 });
  for (const k of ["range", "service", "model", "date", "month"]) if (q.has(k)) p.set(k, q.get(k)!);
  try {
    return await adminGet<Usage>(request, `/api/admin/usage?${p}`, timeoutMs);
  } catch (error) {
    if (error instanceof Response || request.signal.aborted) throw error;
    const today = beijingToday(), date = usageDate(p.get("date") ?? undefined, today);
    return {
      date,
      calendar: { month: usageMonth(p.get("month") ?? date?.slice(0, 7), today), today, days: [], status: { state: "unavailable", asOf: null } },
      range: date ? "date" : ["today", "7", "30", "90", "all"].includes(p.get("range") ?? "") ? p.get("range")! : "all",
      service: p.get("service") ?? "", model: p.get("model") ?? "", rows: [],
      status: { state: "error", asOf: null, message: "用量数据加载失败（后台请求超时或不可用）。" },
    } satisfies Usage;
  }
}

/** 非法日期（例如手改了 ?date=）不该让整页报错：交给面板显示错误态与重试入口。 */
export function invalidDateUsage(range: string): Usage {
  const today = beijingToday();
  return {
    date: null,
    calendar: { month: usageMonth(undefined, today), today, days: [], status: { state: "unavailable", asOf: null } },
    range: ["today", "7", "30", "90", "all"].includes(range) ? range : "all",
    service: "", model: "", rows: [],
    status: { state: "error", asOf: null, message: "日期无效或尚未到来，请选择有效日期。" },
  };
}
