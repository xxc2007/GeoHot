// The post an X item quotes, as X shows it under the post: who wrote it, what they said and a way to
// it. The item's own text and translation often only make sense next to it.
import type { XPostView } from "@aihot/contracts/site";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { IconArrowUpRight } from "../../components/icons";
import { safeExternalHref } from "../../lib/safe-url.ts";
import { useLocale } from "../../lib/i18n";
import { copy } from "../../lib/i18n/item-ui";

type Quoted = NonNullable<XPostView["quoted"]>;

function Author({ quoted }: { quoted: Pick<Quoted, "authorName" | "handle"> }) {
  const t = copy[useLocale()].quoted;
  return (
    <>
      <span className="text-ink-4">{t.quote}</span>
      <span className="font-semibold text-ink-2">{quoted.authorName || `@${quoted.handle}`}</span>
      {quoted.authorName && quoted.handle && <span className="text-ink-4">@{quoted.handle}</span>}
    </>
  );
}

/** Item page: the whole quoted post, in Chinese with the original a tap away (the original view shows the original). */
export function QuotedPost({ quoted, original = false }: { quoted: Quoted; original?: boolean }) {
  const t = copy[useLocale()].quoted;
  const en = useLocale() === "en";
  const zh = original ? null : quoted.translation;
  // /en 只读英文译文或本来就是英文的原文；中文原文不在这里展示（可点原帖），只留一句英文说明。
  const zhOnly = en && !quoted.translation && hasChineseCopy(quoted.text);
  // fallback 模式下后端把中文译文交给 /en（translationLocale='zh'）：它仍是中文，必须逐条说明，
  // 不能只因为它躺在 `translation` 字段里就当英文译文印出去。
  const translationIsZh = en && quoted.translationLocale === "zh";
  const shown = en ? (quoted.translation ?? (hasChineseCopy(quoted.text) ? "" : quoted.text)) : (zh ?? quoted.text);
  // 采集链给的地址只有 http(s) 才配成为链接（lib/safe-url.ts）；不安全时不渲染这个入口。
  const quotedHref = safeExternalHref(quoted.url);
  return (
    <figure className="mt-6 rounded-tile border border-line px-4 py-3.5">
      <figcaption className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
        <Author quoted={quoted} />
      </figcaption>
      {translationIsZh && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-4">{t.zhTranslation}</p>}
      {shown && <blockquote lang={translationIsZh ? "zh-Hans" : undefined} className="mt-2 whitespace-pre-line text-[15px] leading-[1.75] text-ink-2">{shown}</blockquote>}
      {zhOnly && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-4">{t.zhOnly}</p>}
      {!en && zh && (
        <details className="mt-2 text-[13px] text-ink-4">
          <summary className="cursor-pointer select-none hover:text-ink-3">{t.original}</summary>
          <p className="mt-1.5 whitespace-pre-line text-[14px] leading-[1.7] text-ink-3">{quoted.text}</p>
        </details>
      )}
      {quotedHref && (
        <a href={quotedHref} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-0.5 text-[13px] text-accent hover:text-accent-ink">
          {t.viewOnX} <IconArrowUpRight size={13} />
        </a>
      )}
    </figure>
  );
}

/** Feed card: who is quoted and the start of what they said (the card itself opens the item). */
export function QuotedLine({ quoted }: { quoted: Omit<Quoted, "url"> }) {
  const en = useLocale() === "en";
  const t = copy[useLocale()].quoted;
  // 与条目页同一口径：有英文引用译文才读英文；只有中文原文时留一句英文说明，不把中文当英文展示。
  const zhOnly = en && !quoted.translation && hasChineseCopy(quoted.text);
  const translationIsZh = en && quoted.translationLocale === "zh";
  const shown = en ? (quoted.translation ?? (hasChineseCopy(quoted.text) ? "" : quoted.text)) : (quoted.translation ?? quoted.text);
  return (
    <div className="mt-2.5 rounded-tile border border-line-soft px-3 py-2 text-[13px] leading-[1.6]">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <Author quoted={quoted} />
      </div>
      {translationIsZh && <p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-4">{t.zhTranslation}</p>}
      {shown && <p lang={translationIsZh ? "zh-Hans" : undefined} className="mt-0.5 line-clamp-2 text-ink-3">{shown}</p>}
      {zhOnly && <p className="mt-0.5 line-clamp-1 text-[12.5px] text-ink-4">{t.zhOnly}</p>}
    </div>
  );
}
