import { SITE, withSubject } from "@aihot/industry/site";
import { RISK_NOTICE_CATEGORIES, RISK_NOTICE_TAGS } from "@aihot/industry/taxonomy";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/item";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { fullDateTime, relativeTime } from "../lib/format";
import { markRead } from "../lib/local-state";
import { appPath, publicPath } from "../lib/public-path";
import { SelectedBadge } from "../components/ui/Badge";
import { ScoreLabel } from "../components/ui/Score";
import { PillTabs } from "../components/ui/Tabs";
import { ArticleLayout, RailSection } from "../components/ui/Page";
import { Menu, MenuItem } from "../components/ui/Menu";
import { StarButton } from "../features/feed/parts";
import { GroupSources } from "../features/feed/ReadingGroup";
import { StoryFollowups } from "../features/item/StoryFollowups";
import { MediaGallery } from "../features/item/MediaGallery";
import { QuotedPost } from "../features/item/QuotedPost";
import { IconArrowLeft, IconCopy, IconDownload, IconExternal, IconImage, IconList, IconMenu, IconShare } from "../components/icons";

const PosterSheet = lazy(() => import("../features/item/PosterSheet"));
const TocSheet = lazy(() => import("../features/item/TocSheet"));

export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}`, { signal: request.signal });
  return { item };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("内容不存在") }, { name: "robots", content: "noindex" }];
  const { item } = loaderData;
  return pageMeta({
    title: item.title,
    description: item.summary ?? undefined,
    path: `/items/${item.id}`,
    image: `/og/items/${item.id}.png`,
    type: "article",
    noindex: !item.indexable,
    jsonLd: breadcrumbLd([
      { name: SITE.name, path: "/" },
      { name: item.selected ? "精选" : "全部动态", path: item.selected ? "/" : "/all" },
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

async function shareOrCopy(item: Pick<SiteItemDetail, "id" | "title">): Promise<"shared" | "copied" | null> {
  const url = `${siteUrl()}/items/${item.id}`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: item.title, url });
      return "shared";
    }
    await navigator.clipboard.writeText(`${item.title}\n${url}`);
    return "copied";
  } catch {
    return null;
  }
}

/**
 * 认得的目的地 → 「返回」后面的那几个字。这张表是唯一的认路来源：表外的路径一律不写去处，
 * 宁可只写「返回」，也不编一个可能跳错的落点。
 */
const PLACES: Array<readonly [RegExp, string]> = [
  [/^\/$/, "精选"],
  [/^\/all$/, "全部动态"],
  [/^\/hot$/, "热点榜"],
  [/^\/starred$/, "收藏"],
  [/^\/topics$/, "主题"],
  [/^\/topics\/[^/]+$/, "主题页"],
  [/^\/story\/[^/]+$/, "事件页"],
  [/^\/daily(\/|$)/, "日报"],
  [/^\/weekly(\/|$)/, "周报"],
  [/^\/monthly(\/|$)/, "月报"],
  [/^\/leaderboard(\/|$)/, "榜单"],
  [/^\/about$/, "关于"],
  [/^\/changelog$/, "更新日志"],
  [/^\/more$/, "更多"],
];

/**
 * 把一个「来路」值折成一个去处和它的名字。值必须是站内绝对路径（`//host` 是协议相对的站外地址，
 * 挡掉），并且先过 `appPath()` 剥掉部署前缀——`/geohot/all` 认成 `/all`，否则子路径部署下这条链接
 * 会跳到同域名上的另一个站（`docs/known-issues.md`「子路径链接退化」）。查询串原样保留，所以从
 * `/all?tag=…` 进来就回到那个筛选结果，不是回到裸 `/all`。
 */
function backPlace(value: string | null): { name: string; to: string } | null {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;
  const cut = value.indexOf("?");
  const pathname = appPath(cut < 0 ? value : value.slice(0, cut)).replace(/(.)\/+$/, "$1");
  const hit = PLACES.find(([re]) => re.test(pathname));
  return hit ? { name: hit[1], to: cut < 0 ? pathname : `${pathname}${value.slice(cut)}` } : null;
}

/**
 * 条目页的「返回」回哪去，按优先级：显式的 `?from=` → 站内 `document.referrer` → 都判不出。
 * `from` 读自 `useSearchParams`，服务端与客户端第一帧拿到同一个值；`referrer` 只能在 effect 里读
 * （服务端没有 document），所以它只在水合之后把中性的「返回」换成写明去处的链接，不会让两端首帧不同。
 * 判不出时沿用老规矩：能后退一步就后退，否则按条目是否精选猜一个落点。
 */
function useBackTarget(selected: boolean): { name: string | null; to: string } {
  const [params] = useSearchParams();
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
  return backPlace(from) ?? backPlace(referred) ?? { name: null, to: selected ? "/" : "/all" };
}

const BACK_CLASS = "-ml-1.5 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 text-[14px] text-ink-2 transition-colors hover:text-ink lg:text-[13px] lg:text-ink-3";

export default function ItemPage() {
  const { item } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const hasTranslation = item.hasTranslation;
  const lang = item.bodyLanguage;
  const [posterRequested, setPosterRequested] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  const [tocRequested, setTocRequested] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => markRead(item.id), [item.id]);
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
    if (r === "copied") setToast("链接已复制");
  };

  const bodyHtml = lang === "zh" ? (item.body?.zh ?? item.body?.original) : (item.body?.original ?? item.body?.zh);
  const bodyLabel = !item.body ? null : lang === "zh" && item.body.zhKind === "translation" ? "正文 · AI 翻译" : lang === "original" && hasTranslation ? "正文 · 原文" : "正文";
  const isX = item.channel === "x" && !!item.x;
  const publishedIso = item.publishedAt ?? item.discoveredAt;
  const summaryOnly = item.readingMode === "summary-only";
  const showOutline = item.outline.length >= 3;
  const originalLabel = isX ? "在 X 查看原推" : "打开原文";
  // 使用规则第 3 条（/terms#s4）对全站一体适用，但灾害与预警类条目要在读者决定行动的那一段话下面指回去一次。
  const riskNotice = RISK_NOTICE_CATEGORIES.includes(item.category ?? "") || item.tags.some((t) => RISK_NOTICE_TAGS.includes(t));

  const related = item.relatedStories.filter((s) => s.publicId !== item.story?.publicId);

  const backTarget = useBackTarget(item.selected);
  const backLabel = backTarget.name === null ? "返回" : `返回${backTarget.name}`;
  // 判不出去处时不硬编一个名字，走历史后退；判得出就写明去处，并且用一条真链接（没有脚本也走得通）。
  const backButton =
    backTarget.name === null ? (
      <button
        type="button"
        onClick={() => {
          if (window.history.state?.idx > 0) navigate(-1);
          else navigate(backTarget.to);
        }}
        className={BACK_CLASS}
      >
        <IconArrowLeft size={16} /> {backLabel}
      </button>
    ) : (
      <Link to={backTarget.to} className={BACK_CLASS}>
        <IconArrowLeft size={16} /> {backLabel}
      </Link>
    );
  const moreMenu = (
    <Menu label="更多操作" trigger={<IconMenu size={17} />}>
      {(close) => (
        <>
          <MenuItem icon={<IconShare size={15} />} onSelect={() => { close(); void share(); }}>分享链接</MenuItem>
          <MenuItem icon={<IconImage size={15} />} onSelect={() => { close(); openPoster(); }}>生成分享海报</MenuItem>
          <MenuItem
            icon={<IconCopy size={15} />}
            onSelect={async () => {
              close();
              try {
                await navigator.clipboard.writeText(`${siteUrl()}/items/${item.id}`);
                setToast("链接已复制");
              } catch {
                // clipboard unavailable
              }
            }}
          >
            复制链接
          </MenuItem>
          {item.markdownAvailable && (
            <MenuItem icon={<IconDownload size={15} />} href={publicPath(`/items/${item.id}/markdown`)} download onSelect={close}>
              导出 Markdown
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
  // Desktop actions head the right rail, one row as tall as 返回 at the head of the left one.
  const actions = (
    <div className="flex items-center gap-1">
      <a
        href={item.links.original}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
      >
        {originalLabel} <IconExternal size={13} />
      </a>
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
    <RailSection title="来源">
      <div className="text-[14px] font-semibold leading-snug text-ink">{isX ? item.x!.authorName : item.source.name}</div>
      <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        {isX ? `@${item.x!.handle} · X` : item.author ?? hostOf(item.links.original)}
      </div>
      <div className="mt-3 text-[12px] text-ink-4">发布时间</div>
      <time dateTime={publishedIso} className="mono mt-0.5 block text-[12.5px] text-ink-2">
        {fullDateTime(publishedIso)}
      </time>
      <div className="mt-0.5 text-[12px] text-ink-4" suppressHydrationWarning>
        {relativeTime(publishedIso)}
      </div>
    </RailSection>
  );
  const outline = showOutline && (
    <RailSection title="本文目录">
      <nav aria-label="本文目录">
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
        <RailSection title="推荐理由">
          {verdict && <div className="mb-3">{verdict}</div>}
          <p className="text-[13.5px] leading-[1.8] text-ink-2">{item.reason}</p>
        </RailSection>
      ) : (
        verdict && <RailSection title="AI 评分">{verdict}</RailSection>
      )}
      {item.tags.length > 0 && (
        <RailSection title="标签">
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 8).map((t) => (
              <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="chip">
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
            aria-label="本文目录"
            title="本文目录"
            aria-haspopup="dialog"
            aria-expanded={tocOpen}
            onClick={openToc}
            className="inline-flex h-8 items-center gap-1 whitespace-nowrap px-1.5 text-[14px] text-ink-2 transition-colors hover:text-ink"
          >
            <IconList size={15} /> 目录
          </button>
        )}
        <StarButton item={item} size={32} />
        <a href={item.links.original} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 px-1.5 text-[14px] text-ink-2">
          <IconExternal size={15} /> 原文
        </a>
        <button type="button" aria-label="分享" onClick={share} className="inline-flex size-8 items-center justify-center rounded-full text-ink-3 hover:text-ink">
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
            <span suppressHydrationWarning>· {relativeTime(publishedIso)}</span>
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
          {!isX && <h1 className="text-[26px] font-bold leading-[1.38] tracking-[-0.01em] text-ink lg:text-[32px] lg:leading-[1.34] xl:text-[36px] xl:leading-[1.3]">{item.title}</h1>}
          {!isX && item.originalTitle && <p className="mt-2.5 text-[14px] leading-relaxed text-ink-4">{item.originalTitle}</p>}

          {item.summary && (
            <section className={isX ? "mt-4" : "mt-7 xl:mt-8"}>
              <div className="mb-2 text-[12px] font-semibold text-accent">{summaryOnly ? "摘要" : "AI 导读"}</div>
              <p className="text-[18px] leading-[1.7] text-ink xl:text-[20px] xl:leading-[1.7]">{item.summary}</p>
            </section>
          )}

          {riskNotice && (
            <p className="mt-3 border-t border-line-soft pt-2.5 text-[12.5px] leading-relaxed text-ink-4">
              本站不是预警信息的发布机构，本页内容不构成预警依据；防灾、避险与出行决定请以官方台网与应急部门当次正式发布为准（
              <Link to="/terms#s4" className="text-accent hover:underline">使用规则第 3 条</Link>）。
            </p>
          )}

          {item.reason && !summaryOnly && (
            <section className="mt-6 border-t border-line pt-4 lg:hidden">
              <div className="mb-1 text-[12px] font-semibold text-ink-3">推荐理由</div>
              <p className="text-[15px] leading-[1.75] text-ink-2">{item.reason}</p>
            </section>
          )}

          {item.group && item.group.reportCount > 1 && (
            <div className="mt-5">
              <GroupSources group={item.group} parentId={item.id} />
            </div>
          )}

          {summaryOnly && <p className="mt-7 rounded-control bg-bg-sunk px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">应来源方要求，这里只提供摘要与原文入口。完整内容请阅读原文。</p>}

          {item.body && bodyHtml && (
            <section className="mt-9 border-t border-line pt-4 xl:mt-10">
              <div className="mb-6 flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-4">{bodyLabel}</span>
                {hasTranslation && (
                  <PillTabs
                    size="xs"
                    layoutId="item-body-lang"
                    label="正文语言"
                    active={lang}
                    items={[
                      { key: "zh", label: "中文", prefetch: "intent", replace: true, to: `/items/${item.id}` },
                      { key: "original", label: "原文", prefetch: "intent", replace: true, to: `/items/${item.id}/original` },
                    ]}
                  />
                )}
              </div>
              {hasTranslation && lang === "zh" && !item.body.complete && (
                <p className="mb-5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] text-ink-3">译文尚不完整，完整内容请切换到原文。</p>
              )}
              {/* 目录树只挂在左右侧栏（Page.tsx 的两道 aside 都是 hidden lg:block），工具栏那个按钮又要水合
                  之后才按得动。没有脚本时按钮是死的——root.tsx 的 <noscript> 已经全站说过一次哪些控件用不了，
                  这里不再重复那句话，只把同一份 outline 摆成一条不需要脚本就能走的路：小节锚点本来就在
                  服务端的 HTML 里。 */}
              {showOutline && (
                <noscript>
                  <details className="mb-6 rounded-control border border-line bg-raised px-3 py-2 lg:hidden">
                    <summary className="text-[13px] font-semibold text-ink">本文目录</summary>
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
              <div className="prose" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            </section>
          )}

          {isX && item.x!.media.length > 0 && <MediaGallery media={item.x!.media} postUrl={item.links.original} />}
          {isX && item.x!.quoted?.text && <QuotedPost quoted={item.x!.quoted} original={lang === "original"} />}

          <p className="mt-8 text-[13px] text-ink-4">
            来源：
            <a href={item.links.original} target="_blank" rel="noopener noreferrer" className="text-ink-3 hover:text-accent">
              {isX ? item.x!.authorName : item.source.name}
            </a>
            <span> · {hostOf(item.links.original)}</span>
          </p>

          {item.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden">
              {item.tags.slice(0, 6).map((t) => (
                <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="chip">
                  #{t}
                </Link>
              ))}
            </div>
          )}

          {item.story && <StoryFollowups story={item.story} currentId={item.id} />}

          {related.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 text-[14px] font-semibold text-ink">相关事件</h2>
              <ul className="divide-y divide-line-soft">
                {related.map((s) => (
                  <li key={s.publicId}>
                    <Link to={`/story/${s.publicId}`} className="block py-2.5 text-[14px] text-ink-2 hover:text-accent">
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
        <Suspense fallback={null}>
          <PosterSheet id={item.id} title={item.title} open={posterOpen} onClose={closePoster} />
        </Suspense>
      )}
      {tocRequested && showOutline && (
        <Suspense fallback={null}>
          <TocSheet outline={item.outline} open={tocOpen} onClose={closeToc} />
        </Suspense>
      )}
      {toast && (
        <div role="status" className="fixed bottom-[calc(80px+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] text-bg shadow-[var(--shadow-pop)] lg:bottom-8">
          {toast}
        </div>
      )}
    </div>
  );
}
