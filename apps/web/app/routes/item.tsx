import { SITE } from "@aihot/industry/site";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { RISK_NOTICE_CATEGORIES, RISK_NOTICE_TAGS } from "@aihot/industry/taxonomy";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/item";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { fullDateTime, relativeTime } from "../lib/format";
import { markRead } from "../lib/local-state";
import { publicPath } from "../lib/public-path";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/item";
import { ChineseNotice } from "../components/ui/ChineseNotice";
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
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}`, { signal: request.signal });
  return { item };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  if (!loaderData) return [{ title: titled(c.notFoundTitle) }, { name: "robots", content: "noindex" }];
  const { item } = loaderData;
  // 英文页的 SEO 文案优先信源原题（国际信源登记的常是英文原题），缺席再退回中文标题与摘要；中文页不变。
  const enOriginalTitle = locale === "en" && item.originalTitle ? item.originalTitle : null;
  return pageMeta({
    title: enOriginalTitle ?? item.title,
    description: enOriginalTitle ?? item.summary ?? undefined,
    path: `/items/${item.id}`,
    image: `/og/items/${item.id}.png`,
    type: "article",
    noindex: !item.indexable,
    locale,
    jsonLd: breadcrumbLd([
      { name: SITE.name, path: "/" },
      { name: item.selected ? c.crumbSelected : c.crumbAll, path: item.selected ? "/" : "/all" },
      { name: item.title, path: `/items/${item.id}` },
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

async function shareOrCopy(item: Pick<SiteItemDetail, "id" | "title">): Promise<"shared" | "copied" | "cancelled" | "failed"> {
  const url = `${siteUrl()}/items/${item.id}`;
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
  const lang = item.bodyLanguage;
  // 英文页默认读原文：原文正文在场（body.original 非空）时，正文块与引用帖都按原文渲染，切换片
  // 停在原文上，「中文」那一片仍指回中文页。中文页与原路由页维持读取层给的 bodyLanguage。
  const enOriginalFirst = locale === "en" && !!item.body?.original;
  const contentLang: "zh" | "original" = enOriginalFirst ? "original" : lang;
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
    const r = await shareOrCopy(item);
    if (r === "copied") setToast(c.toastCopied);
    else if (r === "failed") setToast(c.shareFailed);
  };

  const bodyHtml = contentLang === "zh" ? (item.body?.zh ?? item.body?.original) : (item.body?.original ?? item.body?.zh);
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
  const showOutline = item.outline.length >= 3;
  // 英文页把信源原题抬成 H1（lang 跟着条目登记的语种走，读屏才不会用中文音念原题），中文标题降为
  // 次行；原题缺席、或原题本身就是中文（中文信源改过标题）时 H1 落在中文上，标题下要有一行说明。
  // 中文页恒走 else 分支，标题结构逐字不变。
  const enH1Original = locale === "en" ? item.originalTitle : null;
  const enH1IsChinese = locale === "en" && (!item.originalTitle || hasChineseCopy(item.originalTitle));
  // 导读标签：英文页注明摘要与导读都是中文写的（仅准摘要与 AI 导读都一样），中文页用词不变。
  const digestTag = summaryOnly
    ? (locale === "en" ? c.summaryZhTag : c.summaryTag)
    : (locale === "en" ? c.aiDigestZhTag : c.aiDigestTag);
  const originalLabel = isX ? c.viewOnX : c.openOriginal;
  // 原文地址来自采集链，前端不假设上游已经筛过 scheme（lib/safe-url.ts）：只有 http(s) 才成为
  // 链接，其余按纯文本显示，绝不把别的 scheme 写进 href。
  const originalHref = safeExternalHref(item.links.original);
  // 视频块的可访问名跟着平台说：X 上是「原推」，视频频道上没有任何"推"可打开。
  const videoLabel = isX ? c.videoOnX : c.videoOriginal;
  // 使用规则第 3 条（/terms#s4）对全站一体适用，但灾害与预警类条目要在读者决定行动的那一段话下面指回去一次。
  const riskNotice = RISK_NOTICE_CATEGORIES.includes(item.category ?? "") || item.tags.some((t) => RISK_NOTICE_TAGS.includes(t));

  const related = item.relatedStories.filter((s) => s.publicId !== item.story?.publicId);

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
                await navigator.clipboard.writeText(`${siteUrl()}/items/${item.id}`);
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
      <div className="text-[14px] font-semibold leading-snug text-ink">{isX ? item.x!.authorName : item.source.name}</div>
      <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        {isX ? `@${item.x!.handle} · X` : item.author ?? hostOf(item.links.original)}
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
      {item.reason && !summaryOnly ? (
        <RailSection title={c.reasonTitle}>
          {verdict && <div className="mb-3">{verdict}</div>}
          <p className="text-[13.5px] leading-[1.8] text-ink-2">{item.reason}</p>
        </RailSection>
      ) : (
        verdict && <RailSection title={c.aiScoreTitle}>{verdict}</RailSection>
      )}
      {item.topics?.length ? (
        <RailSection title={c.topicsTitle}>
          <div className="flex flex-wrap gap-1.5">
            {item.topics.slice(0, 8).map((t) => (
              <Link key={t.slug} to={localeAppPath(`/topics/${t.slug}`, locale)} className="chip">
                {t.name}
              </Link>
            ))}
          </div>
        </RailSection>
      ) : null}
      {item.tags.length > 0 && (
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
            <span className="font-semibold text-ink-2">{isX ? item.x!.authorName : item.source.name}</span>
            {isX && <span>· @{item.x!.handle} · X</span>}
            {item.author && !isX && <span>· {item.author}</span>}
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
          {/* 没有中文稿的条目不再出现在列表与日报里（读取层闸门），但它自己的页面还留着 —— 藏起真内容
              比少几条更糟。这里如实说清为什么它不在别处，以及标题与提要就是原文。 */}
          {!isX && !hasChineseCopy(item.title) && (
            <p className="mb-3 rounded-control border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-ink-3">
              {c.noZhDraftNotice}
            </p>
          )}
          {/* 标题区。英文页把信源原题抬成 H1（lang 跟着条目登记的语种走，读屏才不会用中文读音去念
              一整条英文标题，WCAG 3.1.2），中文标题降为次行；中文页维持中文 H1、原题作次行，逐字不变。 */}
          {!isX && (enH1Original ? (
            <>
              <h1 lang={item.language ?? undefined} className={H1_CLASS}>{enH1Original}</h1>
              {enH1Original !== item.title && (
                <p className="mt-2.5 text-[14px] leading-relaxed text-ink-4">{item.title}</p>
              )}
            </>
          ) : (
            <>
              <h1 className={H1_CLASS}>{item.title}</h1>
              {/* 原文标题不是中文（这一页整体是 zh-CN），把语种写在它自己身上，读屏才不会用中文读音去念
                  一整条英文标题（WCAG 3.1.2）。语种就是条目登记的那一个，不猜。 */}
              {item.originalTitle && item.originalTitle !== item.title && (
                <p lang={item.language ?? undefined} className="mt-2.5 text-[14px] leading-relaxed text-ink-4">{item.originalTitle}</p>
              )}
            </>
          ))}
          {/* A post page has no visual headline (the post card is the page), but a reader on a screen reader
              still needs one level-one heading to navigate by: name it after the same line the lists show —
              on the English page after the source's original title, with the Chinese title kept as a
              hidden supplement. */}
          {isX && (enH1Original && enH1Original !== item.title ? (
            <>
              <h1 className="sr-only" lang={item.language ?? undefined}>{enH1Original}</h1>
              <p className="sr-only">{item.title}</p>
            </>
          ) : (
            <h1 className="sr-only">{item.title}</h1>
          ))}
          {/* 英文页的 H1 落在中文上（没有原题，或原题本身就是中文）才需要这一行说明：说明放在标题
              下面，而不是像从前那样一刀切挂在页首。标题本身是原题时内容语言如实可见，不再重复。
              中文页渲染为空。 */}
          {enH1IsChinese && <ChineseNotice className="mt-2.5" />}

          {item.summary && (
            <section className={isX ? "mt-4" : "mt-7 xl:mt-8"}>
              <div className="mb-2 text-[12px] font-semibold text-accent">{digestTag}</div>
              <p className="text-[18px] leading-[1.7] text-ink xl:text-[20px] xl:leading-[1.7]">{item.summary}</p>
            </section>
          )}

          {riskNotice && (
            <p className="mt-3 border-t border-line-soft pt-2.5 text-[12.5px] leading-relaxed text-ink-4">
              {c.riskNoticePre}
              <Link to={localeAppPath("/terms#s4", locale)} className="text-accent hover:underline">{c.riskTermsLink}</Link>
              {c.riskNoticePost}
            </p>
          )}

          {item.reason && !summaryOnly && (
            <section className="mt-6 border-t border-line pt-4 lg:hidden">
              <div className="mb-1 text-[12px] font-semibold text-ink-3">{c.reasonTitle}</div>
              <p className="text-[15px] leading-[1.75] text-ink-2">{item.reason}</p>
            </section>
          )}

          {item.group && item.group.reportCount > 1 && (
            <div className="mt-5">
              <GroupSources group={item.group} parentId={item.id} />
            </div>
          )}

          {summaryOnly && (
            <p className="mt-7 rounded-control bg-bg-sunk px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">
              {c.summaryOnlyNotice}
            </p>
          )}

          {item.body && bodyHtml && (
            <section className="mt-9 border-t border-line pt-4 xl:mt-10">
              <div className="mb-6 flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-4">{bodyLabel}</span>
                {hasTranslation && (
                  <PillTabs
                    size="xs"
                    layoutId="item-body-lang"
                    label={c.bodyLangLabel}
                    active={contentLang}
                    items={[
                      // 「中文」这一片有意回中文页：英文页的正文块默认排原文（enOriginalFirst），
                      // 要读中文正文就得换到那一页；它不随 locale 加前缀。
                      { key: "zh", label: c.langZh, prefetch: "intent", replace: true, to: `/items/${item.id}` },
                      // 「原文」这一片留在英文界面：/en/items/:id/original 已注册（routes.ts），
                      // 不加前缀会把 /en 读者送到中文壳（2026-11-22 审查）。
                      { key: "original", label: c.original, prefetch: "intent", replace: true, to: localeAppPath(`/items/${item.id}/original`, locale) },
                    ]}
                  />
                )}
              </div>
              {/* 英文页正文落在中文上的两种如实说明：只有中文译文（原文正文没抓到）时用通用的
                  ChineseNotice；正文本来就是中文原创（zhKind === "original"）的，说明得更直白——
                  这一篇没有其他语言的正文可切。正文按原文渲染时不出现。中文页渲染为空。 */}
              {locale === "en" && item.body.zhKind === "original" ? (
                <p className="mb-5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] leading-relaxed text-ink-3">{c.bodyZhOriginalNotice}</p>
              ) : locale === "en" && !item.body.original ? (
                <ChineseNotice className="mb-5" />
              ) : null}
              {hasTranslation && contentLang === "zh" && !item.body.complete && (
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
                {isX ? item.x!.authorName : item.source.name}
              </a>
            ) : (
              <span title={c.originalNotHttp} className="text-ink-4">
                {isX ? item.x!.authorName : item.source.name}
              </span>
            )}
            <span> · {hostOf(item.links.original)}</span>
          </p>

          {/* 手机上右侧栏不渲染，主题/标签照桌面右栏的顺序在这里收尾（主题在上，标签在下）。 */}
          {item.topics?.length ? (
            <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden">
              {item.topics.slice(0, 8).map((t) => (
                <Link key={t.slug} to={localeAppPath(`/topics/${t.slug}`, locale)} className="chip">
                  {t.name}
                </Link>
              ))}
            </div>
          ) : null}

          {item.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden">
              {item.tags.slice(0, 6).map((t) => (
                <Link key={t} to={localeAppPath(`/all?tag=${encodeURIComponent(t)}`, locale)} className="chip">
                  #{t}
                </Link>
              ))}
            </div>
          )}

          {item.story && <StoryFollowups story={item.story} currentId={item.id} />}

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
