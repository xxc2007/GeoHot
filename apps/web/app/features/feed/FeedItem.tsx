// One report in a feed. Desktop (≥ 961px): a white card beside the time rail. Mobile: a compact row
// with a divider, the reason in a grey box. One markup, two presentations, as on the original site.
import { memo } from "react";
import { Link } from "react-router";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, FeedItemSummary, TimelineFilters } from "@aihot/contracts/site";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { Badge, SelectedBadge } from "../../components/ui/Badge";
import { ScoreLabel } from "../../components/ui/Score";
import { localeAppPath, useLocale } from "../../lib/i18n";
import { copy as feedCopy } from "../../lib/i18n/feed";
import { MediaThumbs, SourceLine, StarButton } from "./parts";
import { GroupDevelopments, GroupSources, LatestDevelopment } from "./ReadingGroup";
import { QuotedLine } from "../item/QuotedPost";

export interface FeedItemProps {
  item: FeedItemSummary;
  group?: GroupInfo | null;
  filters?: TimelineFilters;
  read?: boolean;
  onOpen?: (id: string) => void;
  /** Show tags under the text (全部动态, topics, search); the category moved into the card header. */
  showTags?: boolean;
}

export const FeedItem = memo(function FeedItem({ item, group, filters, read = false, onOpen, showTags = false }: FeedItemProps) {
  const isX = item.channel === "x" && !!item.x;
  const open = () => onOpen?.(item.id);
  // /en 的 title/summary/reason/source.name/tags 都由读取层按 lang=en 投影过（有英文用英文，
  // 缺英文回退中文并带 textLocale）；页面不再自己拿 originalTitle 盖住 title。
  // originalTitle 只当副题：英文页在主标题缺失或仍是中文时，把信源原题放在标题下面（它是信源自己的话）。
  const locale = useLocale();
  const title = item.title;
  const titleZh = locale === "en" && !!title && hasChineseCopy(title);
  // 2026-11-27：英文页缺 AI 英文稿时，读取层回退中文标题。此时若信源原题本身就是英文，就把
  // **原题提到主标题位**、中文 AI 稿降为副题——英文读者先读到英文，而不是先读到中文
  // 再在下一行找英文（站长反馈的「英文页面还是有的时候会显示出中文」正是这一屏）。
  const englishOriginal = item.originalTitle && !hasChineseCopy(item.originalTitle) ? item.originalTitle : null;
  const swapToOriginal = !!titleZh && !!englishOriginal && englishOriginal !== title;
  const head = swapToOriginal ? englishOriginal! : title;
  const subZh = swapToOriginal ? title : null;
  const originalAsSub = !swapToOriginal && locale === "en" && (!title || titleZh) && !!item.originalTitle && item.originalTitle !== title;
  // 英文页的 <html lang="en"> 下会混进回退的中文：按每段文字自己的语种标注，
  // 读屏才不会拿英语音去念整句中文（WCAG 3.1.2）；中文页 <html lang="zh-CN">，不必逐条再标。
  const contentLang = (text: string | null | undefined) => (locale === "en" && text && hasChineseCopy(text) ? "zh-Hans" : undefined);
  const showSources = !!group && (group.additionalSourceCount > 0 || (group.developmentCount <= 1 && group.reportCount > 1));
  const showDevelopments = !!group?.story && group.developmentCount > 1;
  const tags = showTags ? item.tags.slice(0, 3) : [];
  // 英文页的逐卡语言标注：页面顶部那一句只说明「有的条目是中文」，读者扫卡片时要能逐条
  // 分得清哪一段不是英文。AI 摘要（summary）回退中文时说摘要；只有标题那一层是中文时才说标题。
  // 与条目详情页的 `AI digest, in Chinese` 同一句话；中文页永不渲染。
  const aiDigestZh = locale === "en" && !!item.summary && hasChineseCopy(item.summary);
  const zhLabel = aiDigestZh ? feedCopy[locale].aiDigestZh : titleZh ? feedCopy[locale].titleZh : null;

  return (
    <article className="relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[18px] items-center gap-2 text-[12.5px] leading-[18px] text-ink-4">
        <SourceLine item={item} className="text-ink-4" />
        {item.category && <Link to={localeAppPath(`/all?category=${item.category}`, locale)} className="relative z-10 shrink-0 text-ink-3 transition-colors hover:text-accent">{feedCopy[locale].category[item.category]}</Link>}
        {item.selected && (
          <span className="hidden lg:inline-flex">
            <SelectedBadge />
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <span className="hidden lg:inline-flex">
            <ScoreLabel score={item.score} />
          </span>
          <span className="lg:hidden">
            <ScoreLabel score={item.score} compact />
          </span>
          <span className="-my-1 hidden lg:inline-flex">
            <StarButton item={item} />
          </span>
        </span>
      </header>

      {isX ? (
        <>
          {zhLabel && <div className="mt-2 flex"><Badge tone="neutral">{zhLabel}</Badge></div>}
          <p lang={contentLang(item.summary ?? title)} className={`measure ${zhLabel ? "mt-1.5" : "mt-2"} whitespace-pre-line text-lead leading-[1.75] line-clamp-5 lg:line-clamp-4 ${read ? "text-ink-4" : "text-ink"}`}>
            <IntentLink to={localeAppPath(`/items/${item.id}`, locale)} onClick={open} className="after:absolute after:inset-0 after:content-['']">
              {item.summary ?? title}
            </IntentLink>
          </p>
        </>
      ) : (
        // The card's text column, capped at the site's own prose measure (`--measure-cjk`, 42 characters a
        // line). The desktop feed runs as wide as `--page-max-wide` — 1200px at the floor, and it grows
        // with the window's height, not its width, so it never engaged: a summary measured 1065px at 15px
        // on a 1440 screen (71 Chinese characters on one line) and ~1562px on 1920 (~104). The cap is 42em
        // at this column's inherited size (body, 14px) = 588px, so no line in it runs past 39 characters
        // at 15px or 34 at the 17px title; a measure cap has to be taken at one size, and under 42
        // everywhere is the point. The card, its rule and the time rail keep the full width.
        <div className="measure min-w-0">
          <h3 lang={contentLang(head)} className={`mt-2 line-clamp-2 text-subhead font-bold leading-[1.55] lg:line-clamp-none lg:font-[650] ${read ? "text-ink-4" : "text-ink"}`}>
            <IntentLink to={localeAppPath(`/items/${item.id}`, locale)} onClick={open} className="after:absolute after:inset-0 after:content-['']">
              {head}
            </IntentLink>
          </h3>
          {subZh && <p lang="zh-Hans" className="mt-1 line-clamp-2 text-[13px] leading-[1.6] text-ink-4">{subZh}</p>}
          {originalAsSub && <p lang={hasChineseCopy(item.originalTitle!) ? "zh-Hans" : undefined} className="mt-1 line-clamp-2 text-[13px] leading-[1.6] text-ink-4">{item.originalTitle}</p>}
          {zhLabel && <div className="mt-1.5 flex"><Badge tone="neutral">{zhLabel}</Badge></div>}
          {item.summary && <p lang={contentLang(item.summary)} className={`${zhLabel ? "mt-1 lg:mt-1.5" : "mt-1.5 lg:mt-2"} line-clamp-2 text-[14.5px] leading-[1.75] text-ink-3 lg:line-clamp-3 lg:text-lead`}>{item.summary}</p>}
        </div>
      )}

      {isX && item.x!.media.length > 0 && <MediaThumbs media={item.x!.media} className="mt-2.5" />}
      {!isX && item.media?.length ? <MediaThumbs media={item.media} className="mt-2.5" /> : null}
      {isX && item.x!.quoted?.text && <QuotedLine quoted={item.x!.quoted} />}

      {tags.length > 0 && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-4 lg:flex">
          {tags.map((t) => (
            <Link key={t} to={localeAppPath(`/all?tag=${encodeURIComponent(t)}`, locale)} className="hover:text-accent">
              #{t}
            </Link>
          ))}
        </div>
      )}

      {group && <LatestDevelopment group={group} />}
      {(showSources || showDevelopments) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {showSources && <GroupSources group={group!} filters={filters} parentId={item.id} />}
          {showDevelopments && <GroupDevelopments group={{ ...group!, story: group!.story! }} filters={filters} parentId={item.id} />}
        </div>
      )}

      {item.reason && (
        // The same measure as the title column above, so the desktop rule over it ends where its text does.
        <div className="measure mt-2.5 rounded-control bg-bg-sunk px-3 py-2 dark:bg-bg-muted/60 lg:mt-3 lg:rounded-none lg:border-t lg:border-line-soft lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-3 lg:dark:bg-transparent">
          <p lang={contentLang(item.reason)} className="line-clamp-2 text-[13px] leading-[1.65] text-ink-3 lg:line-clamp-none lg:leading-[1.75] lg:text-note">{feedCopy[locale].reasonLabel}{item.reason}</p>
        </div>
      )}
    </article>
  );
});
