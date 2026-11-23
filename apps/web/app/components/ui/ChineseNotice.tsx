// /en 缺英文稿时的一句标注：只在英文页渲染，中文页永不出现（locale 由路径判定）。
// 内容本身按读取层投影——有英文就显示英文，只有真回退中文时才调用这一句，不把中文说成英文。
import { useLocale } from "../../lib/i18n";

export function MissingEnglishNotice({ className = "", message = "This page has no English version yet — the content below is shown in Chinese." }: { className?: string; message?: string }) {
  const locale = useLocale();
  if (locale !== "en") return null;
  return <p className={`text-[12.5px] text-ink-4 ${className}`}>{message}</p>;
}

/** 反馈查询结果这类只有中文状态词的小块：说明本段内容是中文，不冒充英文。 */
export function ChineseContentNotice({ className = "", message = "This status text is published in Chinese." }: { className?: string; message?: string }) {
  const locale = useLocale();
  if (locale !== "en") return null;
  return <p className={`text-[12.5px] text-ink-4 ${className}`}>{message}</p>;
}