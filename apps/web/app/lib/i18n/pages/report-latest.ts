// 最近一期报纸页（routes/report-latest.tsx）。字典形状与其他页面一致：`en: typeof zh` 锁住两套键，
// 按期种分叉的句子写成函数、页面把 kind 传进来。中文输出与 i18n 之前逐字相同。
import { SITE, withSubject } from "@aihot/industry/site";
import type { ReportKind } from "@aihot/contracts/site";

/**
 * 三种报纸的名字：中文照抄 features/report/format.ts 的 KIND_LABEL（页面原先就用它拼这些句子），
 * 英文与侧栏同一套叫法（shell/nav.ts 的 labelEn：Daily brief）。
 */
const KIND_LABEL: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };
const KIND_LABEL_EN: Record<ReportKind, string> = { daily: "Daily brief", weekly: "Weekly brief", monthly: "Monthly brief" };

const zh = {
  /** 页签标题就是报纸的名字（地理日报）。 */
  metaTitle: (kind: ReportKind) => withSubject(KIND_LABEL[kind]),
  /** 一句 meta 描述，按期种分叉（与 i18n 之前的三元式逐字相同）。 */
  metaDescription: (kind: ReportKind) =>
    kind === "daily" ? `${SITE.name} 每天 08:00（北京时间）发布的${withSubject("日报")}。` : kind === "weekly" ? `每周一期，回顾一周的${withSubject("动态")}。` : `每月一期，盘点当月的${withSubject("动态")}。`,

  /** 最近一期还没出刊（窗口未合上、往前翻几期也没读到出刊的那一期）的空态。 */
  notPublished: (kind: ReportKind) => `还没有发布${withSubject(KIND_LABEL[kind])}`,
  emptyBody: "第一期发布后会出现在这里。",

  /** 读不到最近一期（接口故障）的错误页：一句实话，加一次重试。 */
  unreadableTitle: (kind: ReportKind) => `暂时读不到${withSubject(KIND_LABEL[kind])}`,
  retrying: "正在重试…",
  retry: "重试",
  errorBody: "服务没有给出这一页要用的数据，所以现在还不能说今天这一期出刊了没有。稍等几秒再试一次。",
};

const en: typeof zh = {
  metaTitle: (kind: ReportKind) => KIND_LABEL_EN[kind],
  // 与中文侧一样只说事实，不给读者"正文也是英文"的错觉（报纸标题与正文仍是模型写的中文）。
  metaDescription: (kind: ReportKind) =>
    kind === "daily" ? "GEOHOT's daily brief, published every day at 08:00 (Beijing time)." : kind === "weekly" ? "A weekly brief reviewing the week's geography updates." : "A monthly brief reviewing the month's geography updates.",

  notPublished: (kind: ReportKind) => `No ${KIND_LABEL_EN[kind].toLowerCase()} published yet`,
  emptyBody: "The first issue will appear here once it is published.",

  unreadableTitle: (kind: ReportKind) => `The ${KIND_LABEL_EN[kind].toLowerCase()} is temporarily unavailable`,
  retrying: "Retrying…",
  retry: "Retry",
  errorBody: "The service did not return the data this page needs, so we cannot yet tell whether today's issue is out. Please wait a few seconds and try again.",
};

export const copy = { zh, en } as const;
