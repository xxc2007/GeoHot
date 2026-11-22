// Report detail page (`routes/report-detail.tsx`, the paper behind /daily|weekly|monthly/:key). Same
// dictionary shape as the other page dicts: `en: typeof zh` keeps the two key sets in lock-step, and
// functions carry runtime values so word order can differ per locale. Chinese output is byte-identical
// to the pre-i18n strings; the paper's body, titles and summaries stay model-written Chinese (the page
// says so with ChineseNotice).
import { SITE, withSubject } from "@aihot/industry/site";
import type { ReportKind } from "@aihot/contracts/site";
import { absentCopy } from "../../../features/report/format";

const zh = {
  /** loader 抛错、拿不到数据时的页签兜底（页面用 titled() 拼上站名）。 */
  metaNotFound: "报告不存在",

  /** 报纸的名字：页签、错误页按钮与缺席提示都要拼上行业词（地理日报）。 */
  kindLabel: {
    daily: withSubject("日报"),
    weekly: withSubject("周报"),
    monthly: withSubject("月报"),
  },

  /** 导语与总述都没有时的 meta 描述兜底（label 由页面按 kind 从 kindLabel 里取）。 */
  metaFallbackDescription: (key: string, label: string) => `${SITE.name} ${key} 的${label}。`,

  /** 往期栏没读到时页面顶部的那一行实话。 */
  navFailed: "往期列表这一次没有读到，左栏因此是空的——这不代表没有往期，这一期报纸本身照常可读。",

  /** 错误页跳最近一期的按钮。 */
  latestAction: (label: string) => `看最近一期${label}`,

  /**
   * 「这一期读不到」的四种情形，各一句标题与一段正文。中文仍是 format.ts 里 absentCopy() 的原话——
   * 那四句话的出处只有一处，这里按情形委托过去；英文在下面逐句对应。kind 供中文版拼行业词，英文版用不上。
   */
  absent: {
    not_yet: {
      title: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "not_yet").title,
      body: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "not_yet").body,
    },
    no_edition: {
      title: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "no_edition").title,
      body: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "no_edition").body,
    },
    bad_key: {
      title: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "bad_key").title,
      body: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "bad_key").body,
    },
    unreadable: {
      title: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "unreadable").title,
      body: (kind: ReportKind, key: string, _label: string) => absentCopy(kind, key, "unreadable").body,
    },
  },
};

const en: typeof zh = {
  metaNotFound: "Report not found",

  // 题名的位置（页签、标题）用首字母大写形式；进入句中（按钮、描述、缺席提示）时由调用处转小写。
  kindLabel: {
    daily: "Daily brief",
    weekly: "Weekly review",
    monthly: "Monthly roundup",
  },
  metaFallbackDescription: (key: string, label: string) => `${SITE.name} ${label.toLowerCase()} for ${key}.`,

  navFailed: "The past-issues list did not load this time, so the sidebar is empty — that does not mean there are no past issues. This issue itself reads as usual.",

  latestAction: (label: string) => `Read the latest ${label.toLowerCase()}`,

  absent: {
    not_yet: {
      title: (_kind: ReportKind, key: string, _label: string) => `“${key}” is not due out yet`,
      body: (_kind: ReportKind, key: string, label: string) =>
        `The period this issue would cover has not ended, so no such edition of the ${label.toLowerCase()} exists here yet. The latest published edition is linked below.`,
    },
    no_edition: {
      title: (_kind: ReportKind, key: string, _label: string) => `No edition for ${key}`,
      body: (_kind: ReportKind, key: string, label: string) =>
        `${SITE.name} published no ${label.toLowerCase()} for ${key} — not one taken down afterwards; the archive never had this issue. Try another date, or start from the latest edition.`,
    },
    bad_key: {
      title: (_kind: ReportKind, _key: string, _label: string) => "This issue key is not one we recognize",
      body: (_kind: ReportKind, _key: string, _label: string) =>
        "Daily issue keys look like 2026-10-09, weekly keys like 2026-W40 and monthly keys like 2026-09. The segment in this address matches none of them — pick an issue from the archive page.",
    },
    unreadable: {
      title: (_kind: ReportKind, _key: string, label: string) => `This edition of the ${label.toLowerCase()} cannot be read right now`,
      body: (_kind: ReportKind, _key: string, _label: string) =>
        "The service did not return the data this page needs, so we cannot yet tell whether this issue was published. Try again in a few seconds.",
    },
  },
};

export const copy = { zh, en } as const;
