// 运行看板的时间口径。纯函数、不碰数据库：`loadModelOps` 与测试都从这一份解析，
// 免得「今天」在两个地方各算一遍、边界（北京时间零点）各错一次。
//
// 站长 2026-11-27：口径改成「今天 / 7 天 / 全部」。原来的 15 分钟…24 小时五档只够盯抖动，
// 看不到一天的长度，也答不了「这个月一共花了多少」。
import { beijingDate } from "@aihot/contracts/time";

export type OpsWindow = "today" | "7d" | "all";
export const OPS_WINDOWS: OpsWindow[] = ["today", "7d", "all"];

/** 兼容旧链接里的 `window=10080`（分钟）与非法值：一律落到最接近的一档，不报错。 */
export function normalizeWindow(raw: string | number | null | undefined): OpsWindow {
  const text = String(raw ?? "").trim();
  if (text === "7d" || text === "all" || text === "today") return text;
  const minutes = Number(text);
  if (Number.isFinite(minutes) && minutes > 0) return minutes >= 1440 * 3 ? "7d" : "today";
  return "today";
}

/**
 * 一档窗口的起点、给看板回显的分钟数与柱宽。
 * 「今天」从北京时间零点起、柱宽 1 小时（最多 24 根）；「7 天」滚动 168 小时、6 小时一根（28 根）；
 * 「全部」不设下界（用 2000-01-01 当哨兵，仍走 started_at 索引）、1 天一根。
 */
export function windowSpec(key: OpsWindow, now = Date.now()): { since: Date; minutes: number; bucket: number } {
  if (key === "all") return { since: new Date("2000-01-01T00:00:00Z"), minutes: 0, bucket: 1440 };
  if (key === "7d") return { since: new Date(now - 7 * 24 * 60 * 60_000), minutes: 10_080, bucket: 360 };
  const since = new Date(`${beijingDate(now)}T00:00:00+08:00`);
  const minutes = Math.max(1, Math.ceil((now - since.getTime()) / 60_000));
  return { since, minutes, bucket: 60 };
}