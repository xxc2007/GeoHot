/**
 * Which language an article is written in, when its feed never said.
 *
 * 2026-11-08：24 小时新进的 458 篇 publications，`language` 全是 NULL。门禁
 * （`publication/readiness.ts` 的 `rawWorkflowReadyCondition`）在语言未知时只剩两条路：
 * 正文前 400 字的 CJK 判据，或者一份完整的中文译文。前者对英文稿不成立，后者要等模型，
 * 于是「每一篇都得先翻译」成了读者面的瓶颈——441 篇未就绪里 440 篇卡在这一条。
 *
 * 判据只用字符统计，不发模型调用，也不改已经写好的值：只在 language 为空时兜底。
 * 中日韩统一表意文字占比过半才算 zh；纯拉丁字母（含变音符号）占绝对多数算 en；
 * 其余（阿拉伯文、西里尔文、混合稿）保持 null，让翻译那条路照旧兜。
 */
export type InferredLanguage = "zh" | "en" | null;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const LATIN = /[A-Za-z\u00c0-\u024f]/gu;
const SAMPLE_CHARS = 2000;

export function inferLanguage(title: string | null | undefined, bodyText: string | null | undefined): InferredLanguage {
  const sample = `${title ?? ""}\n${(bodyText ?? "").slice(0, SAMPLE_CHARS)}`;
  if (!sample.trim()) return null;
  const cjk = sample.match(CJK)?.length ?? 0;
  const latin = sample.match(LATIN)?.length ?? 0;
  const letters = cjk + latin;
  // 12 个字母就够下判断：只有标题的中文短讯（如「自然资源部发布全国国土空间规划纲要」）也有 17 个字。
  if (letters < 12) return null;
  const cjkShare = cjk / letters;
  if (cjkShare >= 0.5) return "zh";
  if (cjkShare <= 0.02 && latin >= 25) return "en";
  return null;
}
