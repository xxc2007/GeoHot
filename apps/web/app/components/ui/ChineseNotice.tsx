// English pages carry one quiet line saying the article content is Chinese: the i18n plan translates
// the interface chrome only — titles, summaries and report bodies are model-written Chinese and stay
// as they are. It renders nothing on Chinese pages (the locale test keeps the call sites unconditional),
// so a page can drop this in once and let the language decide.
import { useLocale } from "../../lib/i18n";

export function ChineseNotice({ className = "" }: { className?: string }) {
  const locale = useLocale();
  if (locale !== "en") return null;
  return <p className={`text-[12.5px] text-ink-4 ${className}`}>Article titles, summaries and reports are published in Chinese.</p>;
}
