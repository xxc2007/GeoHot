// 英文内容层（迁移 0128/0129）的共享词汇与写库负载形状。
//
// 这里只描述写进数据库的英文文本与记账，不改变站点的中文读取模型：语言是读取层投影，
// `publications`/`stories`/`reports` 都不新增 lang 成员列。

/** `english_attempts.kind` 的取值（与 0129 的 CHECK 同一张词表）。 */
export const ENGLISH_ATTEMPT_KINDS = ["copy", "body", "story", "fact", "report", "quote"] as const;
export type EnglishAttemptKind = (typeof ENGLISH_ATTEMPT_KINDS)[number];

/**
 * `english_attempts.outcome` 的取值（与 0129 的 CHECK 同一张词表）。
 *
 * `stale` 是 CAS 失败时唯一正确的记账：读到的源版本与写回时不一致，什么都没写，等 sweep 重排。
 * 不要并进 `failed`——那会被当成真失败，消耗重试上限。
 */
export const ENGLISH_ATTEMPT_OUTCOMES = ["written", "translated", "skipped", "failed", "stale"] as const;
export type EnglishAttemptOutcome = (typeof ENGLISH_ATTEMPT_OUTCOMES)[number];

export function isEnglishAttemptKind(value: unknown): value is EnglishAttemptKind {
  return typeof value === "string" && (ENGLISH_ATTEMPT_KINDS as readonly string[]).includes(value);
}

export function isEnglishAttemptOutcome(value: unknown): value is EnglishAttemptOutcome {
  return typeof value === "string" && (ENGLISH_ATTEMPT_OUTCOMES as readonly string[]).includes(value);
}

/** `quote_translations_en.origin`（与 0038 的 zh 表同义）：模型新译，或复用已有译文。 */
export type EnglishQuoteOrigin = "model" | "reused";

/**
 * `reports.content_en.citations` 的一项：成刊时冻结下来的引用文字。
 *
 * 读取层只认这份快照，不在读时回查 `publications.title_en`——旧刊不能因为条目后来改名而被改写。
 * `itemId` 指向 `reports.content` 里的成员；标题、摘要、来源名与角色都是英文刊面对读者显示的那份。
 */
export interface ReportCitationSnapshot {
  itemId: string;
  title: string;
  summary: string | null;
  sourceName: string;
  role: string | null;
}

/** 日报英文覆盖层：只覆盖导语与各版块标签/摘要；成员 `items` 仍从 `reports.content` 读。 */
export interface DailyReportEnglishOverlay {
  lead: { title: string; leadParagraph: string } | null;
  /** 顺序与 `reports.content.sections` 一致；写多少条就覆盖多少条。 */
  sections: Array<{ label: string; summary: string | null }>;
}

/** 周报/月报英文覆盖层：只覆盖大标题、总述与各主题的标题/摘要；`storyRefs` 仍从 `reports.content` 读。 */
export interface PeriodReportEnglishOverlay {
  headline: string | null;
  overview: string | null;
  /** 顺序与 `reports.content.themes` 一致。 */
  themes: Array<{ heading: string; summary: string | null }>;
}

/**
 * `reports.content_en` 的形状：英文散文覆盖层 + 写时引用快照。
 *
 * 覆盖层按刊种取用：日报读 `lead`/`sections`，周报与月报读 `headline`/`overview`/`themes`。
 * 字段可缺省——英文稿可以只覆盖一部分文字，读取层不会把缺省当成「没有英文刊」。
 */
export interface ReportEnglishContent {
  citations: ReportCitationSnapshot[];
  lead?: DailyReportEnglishOverlay["lead"];
  sections?: DailyReportEnglishOverlay["sections"];
  headline?: PeriodReportEnglishOverlay["headline"];
  overview?: PeriodReportEnglishOverlay["overview"];
  themes?: PeriodReportEnglishOverlay["themes"];
}