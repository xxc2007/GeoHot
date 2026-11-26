import { SITE } from "@aihot/industry/site";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { RISK_NOTICE_CATEGORIES, RISK_NOTICE_TAGS } from "@aihot/industry/taxonomy";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/item";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { apiGet, loadOr404, withLang } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, strictEnglish, titled } from "../lib/seo";
import { fullDateTime, relativeTime } from "../lib/format";
import { markRead } from "../lib/local-state";
import { publicPath } from "../lib/public-path";
import { localeAppPath, localeFromPath, useLocale, type Locale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/item";
import { MissingEnglishNotice } from "../components/ui/ChineseNotice";
import { safeExternalHref } from "../lib/safe-url.ts";
import { backPlace } from "../lib/back-place";
import { SelectedBadge } from "../components/ui/Badge";
import { ScoreLabel } from "../components/ui/Score";
import { PillTabs } from "../components/ui/Tabs";
import { ArticleLayout, RailSection } from "../components/ui/Page";
import { Menu, MenuItem } from "../components/ui/Menu";
import { StarButton } from "../features/feed/parts";
import { GroupSources } from "../features/feed/ReadingGroup";
import { StoryFollowups } from "../features/item/StoryFollowups";
import { MediaGallery } from "../features/item/MediaGallery";
import { ArticleBody } from "../features/item/ArticleBody";
import { QuotedPost } from "../features/item/QuotedPost";
import { IconArrowLeft, IconCopy, IconDownload, IconExternal, IconImage, IconList, IconMenu, IconShare } from "../components/icons";
import { ChunkBoundary } from "../components/ui/ChunkBoundary";

const PosterSheet = lazy(() => import("../features/item/PosterSheet"));
const TocSheet = lazy(() => import("../features/item/TocSheet"));

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeFromPath(new URL(request.url).pathname);
  const loaded = await loadOr404<SiteItemDetail>(withLang(`/api/site/items/${encodeURIComponent(params.id)}`, locale), { signal: request.signal });
  // 条目详情带出的主题名是词表身份；/en 用同一份主题索引的 nameEn 投影，缺英文时如实回退中文。
  if (locale !== "en" || !loaded.topics?.length) return { item: loaded };
  const index = await apiGet<{ topics: Array<{ slug: string; nameEn?: string | null }> }>(withLang("/api/site/topics", locale), { signal: request.signal }).catch(() => null);
  const names = new Map((index?.topics ?? []).map((t) => [t.slug, t.nameEn ?? null]));
  return { item: { ...loaded, topics: loaded.topics.map((t) => ({ ...t, name: names.get(t.slug) ?? t.name })) } };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  if (!loaderData) return [{ title: titled(c.notFoundTitle) }, { name: "robots", content: "noindex" }];
  const { item } = loaderData;
  // `/en` 的 title/summary 已由读取层投影（title 优先英文稿，缺英文时退回信源原题或中文）；
  // 中文页一字不动。SEO 也只读这两个投影字段，不再自己挑 originalTitle。
  // fallback 模式下真回退中文的条目，head 里要用英文兜底句：`<title>`/og:description 不能印中文。
  const noEnglish = locale === "en" && item.textLocale !== "en";
  return pageMeta({
    title: noEnglish ? c.metaNoEnglishTitle : item.title,
    description: noEnglish ? c.metaNoEnglishDescription : item.summary ?? undefined,
    path: `/items/${item.id}`,
    image: `/og/items/${item.id}.png`,
    type: "article",
    // 英文页真的有英文稿时才承诺 hreflang=en；fallback 模式下也不把只有中文回退的 /en 页
    // 当成英文版。noindex 只在 strict 模式下追加，fallback 模式不突然把已上线的 /en 页 deindex。
    enAvailable: item.textLocale === "en",
    noindex: !item.indexable || (locale === "en" && strictEnglish() && item.textLocale !== "en"),
    locale,
    jsonLd: breadcrumbLd([
      { name: SITE.name, path: "/" },
      { name: item.selected ? c.crumbSelected : c.crumbAll, path: item.selected ? "/" : "/all" },
      { name: noEnglish ? c.metaNoEnglishTitle : item.title, path: `/items/${item.id}` },
    ]),
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=120" };
}

/** A 2px accent line across the top that follows long bodies. */
function ReadingProgress() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (ref.current) ref.current.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0})`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return <div ref={ref} aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left scale-x-0 bg-accent transition-transform duration-150 ease-out" />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function shareOrCopy(item: Pick<SiteItemDetail, "id" | "title">, locale: Locale): Promise<"shared" | "copied" | "cancelled" | "failed"> {
  const url = `${siteUrl()}${localeAppPath(`/items/${item.id}`, locale)}`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: item.title, url });
      return "shared";
    }
    await navigator.clipboard.writeText(`${item.title}\n${url}`);
    return "copied";
  } catch (e) {
    // 读者在系统分享面板上按「取消」不是故障；别的都不能装作什么都没发生。
    if ((e as DOMException)?.name === "AbortError") return "cancelled";
    return "failed";
  }
}

/**
 * 条目页的「返回」回哪去，按优先级：显式的 `?from=` → 站内 `document.referrer` → 都判不出。
 * `from` 读自 `useSearchParams`，服务端与客户端第一帧拿到同一个值；`referrer` 只能在 effect 里读
 * （服务端没有 document），所以它只在水合之后把中性的「返回」换成写明去处的链接，不会让两端首帧不同。
 * 判不出时沿用老规矩：能后退一步就后退，否则按条目是否精选猜一个落点。
 */
function useBackTarget(selected: boolean): { name: string | null; to: string; hard: boolean } {
  const [params] = useSearchParams();
  const locale = useLocale();
  const from = params.get("from");
  const [referred, setReferred] = useState<string | null>(null);
  useEffect(() => {
    if (from) return;
    try {
      const ref = new URL(document.referrer);
      if (ref.origin === window.location.origin) setReferred(`${ref.pathname}${ref.search}`);
    } catch {
      // 直接打开、或来路不是一个能解析的 URL：留在中性的「返回」上
    }
  }, [from]);
  // 兜底落点带语言前缀：/en 的条目页判不出去处时回英文的精选/全部（localeAppPath 不加部署前缀，
  // hard 的那一格仍由渲染处套 publicPath）。/en 这一格客户端路由解得开，不再标 hard。
  const fallback = localeAppPath(selected ? "/" : "/all", locale);
  return backPlace(from) ?? backPlace(referred) ?? { name: null, to: fallback, hard: fallback === "/" };
}

const BACK_CLASS = "-ml-1.5 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 text-[14px] text-ink-2 transition-colors hover:text-ink lg:text-[13px] lg:text-ink-3";

/** 标题的排版类：中文标题与信源原题两个 H1 分支共用同一份，字号字重不因语种分叉。 */
const H1_CLASS = "text-[26px] font-bold leading-[1.38] tracking-[-0.01em] text-ink lg:text-[32px] lg:leading-[1.34] xl:text-[36px] xl:leading-[1.3]";

export default function ItemPage() {
  const { item } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const navigate = useNavigate();
  const hasTranslation = item.hasTranslation;
  // 读取层已经按 /en 选好了正文语言（英文译文 → en，源文本身英文 → original，两者都无才回退 zh）。
  // 页面不再自己猜「原文优先」：fallback 模式下正文可能确实是中文，下面按 bodyLanguage 如实标注。
  const contentLang: "zh" | "en" | "original" = item.bodyLanguage;
  const [posterRequested, setPosterRequested] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  const [tocRequested, setTocRequested] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    // markRead 现在是一把跨标签页的写（lib/local-state.ts），返回 Promise：effect 里不能把它当清理函数交回去。
    void markRead(item.id);
  }, [item.id]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);
  const closePoster = useCallback(() => setPosterOpen(false), []);
  const openPoster = () => {
    setPosterRequested(true);
    setPosterOpen(true);
  };
  const closeToc = useCallback(() => setTocOpen(false), []);
  const openToc = () => {
    setTocRequested(true);
    setTocOpen(true);
  };
  const share = async () => {
    const r = await shareOrCopy(item, locale);
    if (r === "copied") setToast(c.toastCopied);
    else if (r === "failed") setToast(c.shareFailed);
  };

  const bodyHtml = contentLang === "zh" ? item.body?.zh : contentLang === "en" ? item.body?.en : item.body?.original;
  // `zhKind === null` is a foreign article with no Chinese draft yet: the block below is the original text,
  // so it must not be labelled the plain 「正文」 a Chinese article gets. AIHOT's own wording is 正文 · 原文.
  const bodyLabel = !item.body ? null : item.body.zhKind === null ? c.bodyOriginal
    : contentLang === "zh" && item.body.zhKind === "translation" ? c.bodyAiTranslation : contentLang === "original" && hasTranslation ? c.bodyOriginal : c.bodyPlain;
  // 长文只贴前段时页面上必须说清贴了多少；数字在这里算，JSX 里只负责排版。
  const truncatedNotice = item.body?.truncated
    ? {
      totalWan: (Math.round((item.body.totalChars ?? 0) / 1000) / 10).toFixed(1),
      shownWan: (Math.round((item.body.shownChars ?? 0) / 1000) / 10).toFixed(1),
    }
    : null;
  const isX = item.channel === "x" && !!item.x;
  const publishedIso = item.publishedAt ?? item.discoveredAt;
  const summaryOnly = item.readingMode !== "full";
  // strict /en 的 200 回退页：条目没有英文稿时，正文区只留英文说明与原站入口。
  // 中文标题/摘要/信源名不在这里当"英文内容"印出来（2026-11-23 第 3 轮：条目页 0 汉字）。
  const englishFallback = locale === "en" && strictEnglish() && (item.textLocale !== "en" || hasChineseCopy(item.title) || (!!item.summary && hasChineseCopy(item.summary)));
  // 英文页在 strict 下不摆中文：标题先看信源原题（若它本身是英文），再退到中性的「Chinese-language item」。
  // 原题是信源自己的话，对英文读者比一个占位标题有用得多（2026-11-27 站长要求英文页零中文）。
  const englishOriginalTitle = item.originalTitle && !hasChineseCopy(item.originalTitle) ? item.originalTitle : null;
  const displayTitle = locale === "en" && strictEnglish() && hasChineseCopy(item.title) ? (englishOriginalTitle ?? c.fallbackTitle) : item.title;
  const displaySummary = englishFallback && item.summary && hasChineseCopy(item.summary) ? null : item.summary;
  const displaySource = englishFallback ? hostOf(item.links.original) : (isX ? item.x!.authorName : item.source.name);
  const displayAuthor = englishFallback ? null : item.author;
  // 中文页的主题名来自 topics.name（中文），不能过滤；只有 /en 才过滤缺英文名的主题。
  const displayTopics = locale === "en" ? (item.topics ?? []).filter((t) => !hasChineseCopy(t.name)) : (item.topics ?? []);
  const showOutline = item.outline.length >= 3;
  // H1 用读取层投影后的 title：/en 有英文稿时就是英文，缺英文时回退信源原题或中文。
  // 原题降为副题：只在 title 缺失或仍是中文（真回退）时显示，不再用它盖住投影后的标题。
  // 中文页维持原结构：中文标题 + 原题副题，逐字不变。
  const showOriginalTitle = !englishFallback && !!item.originalTitle && item.originalTitle !== item.title && (locale === "zh" || !item.title || hasChineseCopy(item.title));
  // 标题本身是中文时，strict /en 用英文回退标题（见上）；中文页不受影响。
  // 摘要/导读标签按实际发出的语言取词：英文页只有回退中文时才注明“in Chinese”。
  const summaryInChinese = !!displaySummary && hasChineseCopy(displaySummary);
  const digestTag = summaryOnly
    ? (locale === "en" && summaryInChinese ? c.summaryZhTag : c.summaryTag)
    : (locale === "en" && summaryInChinese ? c.aiDigestZhTag : c.aiDigestTag);
  const originalLabel = isX ? c.viewOnX : c.openOriginal;
  // 原文地址来自采集链，前端不假设上游已经筛过 scheme（lib/safe-url.ts）：只有 http(s) 才成为
  // 链接，其余按纯文本显示，绝不把别的 scheme 写进 href。
  const originalHref = safeExternalHref(item.links.original);
  // 视频块的可访问名跟着平台说：X 上是「原推」，视频频道上没有任何"推"可打开。
  const videoLabel = isX ? c.videoOnX : c.videoOriginal;
  // 使用规则第 3 条（/terms#s4）对全站一体适用，但灾害与预警类条目要在读者决定行动的那一段话下面指回去一次。
  const riskNotice = RISK_NOTICE_CATEGORIES.includes(item.category ?? "") || item.tags.some((t) => RISK_NOTICE_TAGS.includes(t));

  const related = item.relatedStories.filter((s) => s.publicId !== item.story?.publicId).filter((s) => !englishFallback || !hasChineseCopy(s.title));

  const backTarget = useBackTarget(item.selected);
  const backLabel = backTarget.name === null ? c.back : c.backTo(backTarget.name);
  // 判不出去处时不硬编一个名字，走历史后退；判得出就写明去处，并且用一条真链接（没有脚本也走得通）。
  // `hard` 的那一格（首页）必须交回浏览器导航：`<Link to="/">` 在 basename 部署下会被解析成裸 `/geohot`，
  // 客户端匹配器解不开它——地址栏是对的，页面却是 404。chip 那一处早就这么处理了（Filters.tsx）。
  const backButton =
    backTarget.name === null ? (
      <button
        type="button"
        onClick={() => {
          if (window.history.state?.idx > 0) navigate(-1);
          else if (backTarget.hard) window.location.assign(publicPath(backTarget.to));
          else navigate(backTarget.to);
        }}
        className={BACK_CLASS}
      >
        <IconArrowLeft size={16} /> {backLabel}
      </button>
    ) : backTarget.hard ? (
      <a href={publicPath(backTarget.to)} className={BACK_CLASS}>
        <IconArrowLeft size={16} /> {backLabel}
      </a>
    ) : (
      <Link to={backTarget.to} className={BACK_CLASS}>
        <IconArrowLeft size={16} /> {backLabel}
      </Link>
    );
  const moreMenu = (
    <Menu label={c.moreActions} trigger={<IconMenu size={17} />}>
      {(close) => (
        <>
          <MenuItem icon={<IconShare size={15} />} onSelect={() => { close(); void share(); }}>{c.shareLink}</MenuItem>
          <MenuItem icon={<IconImage size={15} />} onSelect={() => { close(); openPoster(); }}>{c.makePoster}</MenuItem>
          <MenuItem
            icon={<IconCopy size={15} />}
            onSelect={async () => {
              close();
              try {
                await navigator.clipboard.writeText(`${siteUrl()}${localeAppPath(`/items/${item.id}`, locale)}`);
                setToast(c.toastCopied);
              } catch {
                setToast(c.copyFailed);
              }
            }}
          >
            {c.copyLink}
          </MenuItem>
          {item.markdownAvailable && (
            <MenuItem icon={<IconDownload size={15} />} href={publicPath(`/items/${item.id}/markdown`)} download onSelect={close}>
              {c.exportMarkdown}
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
  // Desktop actions head the right rail, one row as tall as 返回 at the head of the left one.
  const actions = (
    <div className="flex items-center gap-1">
      {originalHref ? (
        <a
          href={originalHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
        >
          {originalLabel} <IconExternal size={13} />
        </a>
      ) : (
        <span
          title={c.originalNotHttp}
          className="inline-flex h-8 flex-1 cursor-default items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] font-medium text-ink-4"
        >
          {originalLabel}
        </span>
      )}
      {showOutline && (
        <button
          type="button"
          aria-label={c.tocFull}
          title={c.tocFull}
          aria-haspopup="dialog"
          aria-expanded={tocOpen}
          onClick={openToc}
          className="tap-hit inline-flex size-8 items-center justify-center rounded-full text-ink-3 hover:text-ink"
        >
          <IconList size={17} />
        </button>
      )}
      <StarButton item={item} size={32} />
      {moreMenu}
    </div>
  );
  const verdict = (item.selected || item.score !== null) && (
    <div className="flex items-center gap-2">
      {item.selected && <SelectedBadge />}
      <ScoreLabel score={item.score} />
    </div>
  );

  // Rails: the piece's facts on the left (wide screens), the editor's notes on the right, the outline
  // under the facts (or under the notes when only the right rail shows).
  const facts = (
    <RailSection title={c.sourcesTitle}>
      <div className="text-[14px] font-semibold leading-snug text-ink">{displaySource}</div>
      <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        {isX ? `@${item.x!.handle} · X` : displayAuthor ?? hostOf(item.links.original)}
      </div>
      <div className="mt-3 text-[12px] text-ink-4">{c.publishedLabel}</div>
      <time dateTime={publishedIso} className="mono mt-0.5 block text-[12.5px] text-ink-2">
        {fullDateTime(publishedIso)}
      </time>
      <div className="mt-0.5 text-[12px] text-ink-4" suppressHydrationWarning>
        {relativeTime(publishedIso, locale)}
      </div>
    </RailSection>
  );
  const outline = showOutline && (
    <RailSection title={c.tocFull}>
      <nav aria-label={c.tocFull}>
        <ol className="-ml-px space-y-0.5 border-l border-line">
          {item.outline.map((o) => (
            <li key={o.id}>
              <a href={`#${o.id}`} className={`-ml-px block border-l border-transparent py-1 text-[12.5px] leading-snug text-ink-3 transition-colors hover:border-accent hover:text-ink ${o.level > 2 ? "pl-5" : "pl-3"}`}>
                {o.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </RailSection>
  );
  const notes = (
    <>
      {item.reason && !summaryOnly && !englishFallback ? (
        <RailSection title={c.reasonTitle}>
          {verdict && <div className="mb-3">{verdict}</div>}
          <p className="text-[13.5px] leading-[1.8] text-ink-2">{item.reason}</p>
        </RailSection>
      ) : (
        verdict && <RailSection title={c.aiScoreTitle}>{verdict}</RailSection>
      )}
      {displayTopics.length ? (
        <RailSection title={c.topicsTitle}>
          <div className="flex flex-wrap gap-1.5">
            {displayTopics.slice(0, 8).map((t) => (
              <Link key={t.slug} to={localeAppPath(`/topics/${t.slug}`, locale)} className="chip">
                {t.name}
              </Link>
            ))}
          </div>
        </RailSection>
      ) : null}
      {item.tags.length > 0 && !englishFallback && (
        <RailSection title={c.tagsTitle}>
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 8).map((t) => (
              <Link key={t} to={localeAppPath(`/all?tag=${encodeURIComponent(t)}`, locale)} className="chip">
                #{t}
              </Link>
            ))}
          </div>
        </RailSection>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      {item.body && <ReadingProgress />}

      {/* Phones: a sticky bar with back, 目录, 收藏, the original, share and more. Desktop puts these in the rails. */}
      <div className="sticky top-0 z-30 -mx-4 flex h-12 items-center gap-1.5 border-b border-line-soft bg-bg/95 px-4 backdrop-blur lg:hidden">
        {backButton}
        <span className="flex-1" />
        {showOutline && (
          <button
            type="button"
            aria-label={c.tocFull}
            title={c.tocFull}
            aria-haspopup="dialog"
            aria-expanded={tocOpen}
            onClick={openToc}
            className="inline-flex h-8 items-center gap-1 whitespace-nowrap px-1.5 text-[14px] text-ink-2 transition-colors hover:text-ink"
          >
            <IconList size={15} /> {c.toc}
          </button>
        )}
        <StarButton item={item} size={32} />
        {originalHref ? (
          <a href={originalHref} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 px-1.5 text-[14px] text-ink-2">
            <IconExternal size={15} /> {c.original}
          </a>
        ) : (
          <span title={c.originalNotHttp} className="inline-flex h-8 cursor-default items-center gap-1 px-1.5 text-[14px] text-ink-4">
            <IconExternal size={15} /> {c.original}
          </span>
        )}
        <button type="button" aria-label={c.share} onClick={share} className="tap-hit inline-flex size-8 items-center justify-center rounded-full text-ink-3 hover:text-ink">
          <IconShare size={17} />
        </button>
        {moreMenu}
      </div>

      {/* The text on the page in one column; back and the facts in the left rail, actions and notes in the right. */}
      <ArticleLayout
        left={
          <>
            {backButton}
            {facts}
            {outline}
          </>
        }
        right={
          <>
            {actions}
            {notes}
            <div className="space-y-8 2xl:hidden">{outline}</div>
          </>
        }
      >
        <div className="hidden lg:block 2xl:hidden">{backButton}</div>
        <article className="pb-6 pt-6 lg:pt-2 2xl:pt-1">
          <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-3 2xl:hidden ${isX ? "" : "mb-3"}`}>
            <span className="font-semibold text-ink-2">{displaySource}</span>
            {isX && <span>· @{item.x!.handle} · X</span>}
            {displayAuthor && !isX && <span>· {displayAuthor}</span>}
            <span>·</span>
            <time dateTime={publishedIso} className="mono">{fullDateTime(publishedIso)}</time>
            <span suppressHydrationWarning>· {relativeTime(publishedIso, locale)}</span>
            {item.selected && (
              <span className="ml-1 lg:hidden">
                <SelectedBadge />
              </span>
            )}
            {item.score !== null && (
              <span className="ml-1 lg:hidden">
                <ScoreLabel score={item.score} />
              </span>
            )}
          </div>
          {/* 中文页维持原条件与原句（没有中文稿的条目）。英文页没有英文稿时只留英文回退说明：
              中文标题/摘要不在这里当英文内容出现（2026-11-23 第 3 轮：条目页 0 汉字）。 */}
          {locale === "zh" && !isX && !hasChineseCopy(item.title) && (
            <p className="mb-3 rounded-control border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-ink-3">
              {c.noZhDraftNotice}
            </p>
          )}
          {englishFallback && (
            <p className="mb-3 rounded-control border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-ink-3">
              {item.textLocale === "zh" || hasChineseCopy(item.title) ? c.fallbackNotice : c.fallbackSummaryNotice}
            </p>
          )}
          {/* 标题区用读取层投影后的 title：/en 有英文稿就是英文；没有英文稿时用英文回退标题。
              H1 的 lang 只标真实回退的中文，读屏才不会拿英语音去念整句中文（WCAG 3.1.2）。
              中文页维持中文 H1、原题作次行，逐字不变。 */}
          {!isX && (
            <>
              <h1 lang={locale === "en" ? (hasChineseCopy(displayTitle) ? "zh-Hans" : undefined) : undefined} className={H1_CLASS}>{displayTitle}</h1>
              {showOriginalTitle && (
                <p lang={locale === "zh" ? item.language ?? undefined : hasChineseCopy(item.originalTitle!) ? "zh-Hans" : item.language ?? undefined} className="mt-2.5 text-[14px] leading-relaxed text-ink-4">{item.originalTitle}</p>
              )}
            </>
          )}
          {/* A post page has no visual headline (the post card is the page), but a reader on a screen reader
              still needs one level-one heading to navigate by: the same projected title the lists show. */}
          {isX && <h1 className="sr-only" lang={locale === "en" ? (hasChineseCopy(displayTitle) ? "zh-Hans" : undefined) : undefined}>{displayTitle}</h1>}
          {/* fallback 模式仍会显示中文；这一句只在非 strict 的 /en 出现，strict 用上面的 fallbackNotice。 */}
          {locale === "en" && !strictEnglish() && item.textLocale !== "en" && <MissingEnglishNotice className="mt-2.5" />}

          {displaySummary && (
            <section className={isX ? "mt-4" : "mt-7 xl:mt-8"}>
              <div className="mb-2 text-[12px] font-semibold text-accent">{digestTag}</div>
              <p className="text-[18px] leading-[1.7] text-ink xl:text-[20px] xl:leading-[1.7]">{displaySummary}</p>
            </section>
          )}

          {riskNotice && (
            <p className="mt-3 border-t border-line-soft pt-2.5 text-[12.5px] leading-relaxed text-ink-4">
              {c.riskNoticePre}
              <Link to={localeAppPath("/terms#s4", locale)} className="text-accent hover:underline">{c.riskTermsLink}</Link>
              {c.riskNoticePost}
            </p>
          )}

          {item.reason && !summaryOnly && !englishFallback && (
            <section className="mt-6 border-t border-line pt-4 lg:hidden">
              <div className="mb-1 text-[12px] font-semibold text-ink-3">{c.reasonTitle}</div>
              <p className="text-[15px] leading-[1.75] text-ink-2">{item.reason}</p>
            </section>
          )}

          {item.group && item.group.reportCount > 1 && !englishFallback && (
            <div className="mt-5">
              <GroupSources group={item.group} parentId={item.id} />
            </div>
          )}

          {summaryOnly && !englishFallback && (
            <p className="mt-7 rounded-control bg-bg-sunk px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">
              {c.summaryOnlyNotice}
            </p>
          )}

          {item.body && bodyHtml && (
            <section className="mt-9 border-t border-line pt-4 xl:mt-10">
              <div className="mb-6 flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-4">{bodyLabel}</span>
                {/* 页签：/en 有英文正文时固定 [English, Chinese]，Chinese 有意回到中文页
                    （英文界面里没有中文正文的孪生地址）；中文页维持 [中文, 原文]。 */}
                {(locale === "en" ? contentLang !== "zh" : hasTranslation) && (
                  <PillTabs
                    size="xs"
                    layoutId="item-body-lang"
                    label={c.bodyLangLabel}
                    active={locale === "en" ? "en" : contentLang}
                    items={locale === "en" ? [
                      { key: "en", label: c.bodyEnglish, prefetch: "intent", replace: true, to: localeAppPath(`/items/${item.id}`, locale) },
                      { key: "zh", label: c.langZh, prefetch: "intent", replace: true, to: `/items/${item.id}` },
                    ] : [
                      { key: "zh", label: c.langZh, prefetch: "intent", replace: true, to: `/items/${item.id}` },
                      // 「原文」这一片留在英文界面：/en/items/:id/original 已注册（routes.ts）。
                      { key: "original", label: c.original, prefetch: "intent", replace: true, to: localeAppPath(`/items/${item.id}/original`, locale) },
                    ]}
                  />
                )}
              </div>
              {/* /en 的正文只有中文（英文稿还没写）时如实标注：不出现「英文正文」的假象。
                  中文页永不渲染。 */}
              {locale === "en" && contentLang === "zh" && (
                <p className="mb-5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] leading-relaxed text-ink-3">{c.bodyNoEnglishNotice}</p>
              )}
              {((contentLang === "zh" && hasTranslation) || (locale === "en" && contentLang === "en")) && !item.body.complete && (
                <p className="mb-5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] text-ink-3">{c.translationIncomplete}</p>
              )}
              {/* 长文只贴前段时必须说清楚贴了多少：一篇期刊全文可以有几十万字，页面在半句话处停住
                  而不留一句解释，读者只能以为是站点坏了。 */}
              {truncatedNotice && (
                <p className="mb-5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] text-ink-3">
                  {c.truncateNotice(truncatedNotice.totalWan, truncatedNotice.shownWan)}
                </p>
              )}
              {/* 目录树只挂在左右侧栏（Page.tsx 的两道 aside 都是 hidden lg:block），工具栏那个按钮又要水合
                  之后才按得动。没有脚本时按钮是死的——root.tsx 的 <noscript> 已经全站说过一次哪些控件用不了，
                  这里不再重复那句话，只把同一份 outline 摆成一条不需要脚本就能走的路：小节锚点本来就在
                  服务端的 HTML 里。 */}
              {showOutline && (
                <noscript>
                  <details className="mb-6 rounded-control border border-line bg-raised px-3 py-2 lg:hidden">
                    <summary className="text-[13px] font-semibold text-ink">{c.tocFull}</summary>
                    <ol className="mt-2 space-y-0.5 border-t border-line-soft pt-2">
                      {item.outline.map((o) => (
                        <li key={o.id}>
                          <a href={`#${o.id}`} className={`block py-0.5 text-[13px] leading-snug text-ink-3 transition-colors hover:text-accent ${o.level > 2 ? "pl-4" : "pl-1"}`}>
                            {o.text}
                          </a>
                        </li>
                      ))}
                    </ol>
                  </details>
                </noscript>
              )}
              <ArticleBody html={bodyHtml} />
            </section>
          )}

          {isX && item.x!.media.length > 0 && <MediaGallery media={item.x!.media} postUrl={item.links.original} videoLabel={videoLabel} />}
          {!isX && item.media?.length ? <MediaGallery media={item.media} postUrl={item.links.original} videoLabel={videoLabel} /> : null}
          {isX && item.x!.quoted?.text && <QuotedPost quoted={item.x!.quoted} original={contentLang === "original"} />}

          <p className="mt-8 text-[13px] text-ink-4">
            {c.sourceLabel}
            {originalHref ? (
              <a href={originalHref} target="_blank" rel="noopener noreferrer" className="text-ink-3 hover:text-accent">
                {displaySource}
              </a>
            ) : (
              <span title={c.originalNotHttp} className="text-ink-4">
                {displaySource}
              </span>
            )}
            {!englishFallback && <span> · {hostOf(item.links.original)}</span>}
          </p>

          {/* 手机上右侧栏不渲染，主题/标签照桌面右栏的顺序在这里收尾（主题在上，标签在下）。 */}
          {displayTopics.length ? (
            <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden">
              {displayTopics.slice(0, 8).map((t) => (
                <Link key={t.slug} to={localeAppPath(`/topics/${t.slug}`, locale)} className="chip">
                  {t.name}
                </Link>
              ))}
            </div>
          ) : null}

          {item.tags.length > 0 && !englishFallback && (
            <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden">
              {item.tags.slice(0, 6).map((t) => (
                <Link key={t} to={localeAppPath(`/all?tag=${encodeURIComponent(t)}`, locale)} className="chip">
                  #{t}
                </Link>
              ))}
            </div>
          )}

          {item.story && !englishFallback && <StoryFollowups story={item.story} currentId={item.id} />}

          {related.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 text-[14px] font-semibold text-ink">{c.relatedTitle}</h2>
              <ul className="divide-y divide-line-soft">
                {related.map((s) => (
                  <li key={s.publicId}>
                    <Link to={localeAppPath(`/story/${s.publicId}`, locale)} className="block py-2.5 text-[14px] text-ink-2 hover:text-accent">
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </ArticleLayout>

      {posterRequested && (
        <ChunkBoundary label={c.posterBoundary} locale={locale} onDismiss={() => setPosterRequested(false)}>
          <Suspense fallback={null}>
            <PosterSheet id={item.id} title={item.title} open={posterOpen} onClose={closePoster} />
          </Suspense>
        </ChunkBoundary>
      )}
      {tocRequested && showOutline && (
        <ChunkBoundary label={c.toc} locale={locale} onDismiss={() => setTocRequested(false)}>
          <Suspense fallback={null}>
            <TocSheet outline={item.outline} open={tocOpen} onClose={closeToc} />
          </Suspense>
        </ChunkBoundary>
      )}
      {toast && (
        <div role="status" className="fixed bottom-[calc(80px+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] text-bg shadow-[var(--shadow-pop)] lg:bottom-8">
          {toast}
        </div>
      )}
    </div>
  );
}
