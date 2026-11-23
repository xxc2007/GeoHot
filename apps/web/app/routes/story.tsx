import { SITE } from "@aihot/industry/site";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, redirect, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/story";
import type { StoryDetail, StoryReportView } from "@aihot/contracts/site";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { ApiRedirect, loadOr404, withLang } from "../lib/api.server";
import { breadcrumbLd, pageMeta, strictEnglish, titled } from "../lib/seo";
import { beijingDate, beijingTime, monthDayTime, shortSourceName } from "../lib/format";
import { localeAppPath, localeFromPath, useLocale, type Locale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/story";
import { MissingEnglishNotice } from "../components/ui/ChineseNotice";
import { backPlace } from "../lib/back-place";
import { publicPath } from "../lib/public-path";
import { getTimelineOrder, setTimelineOrder, type TimelineOrder } from "../lib/local-state";
import { HeatChart } from "../features/story/HeatChart";
import { Badge, SelectedBadge } from "../components/ui/Badge";
import { PillTabs } from "../components/ui/Tabs";
import { Select } from "../components/ui/Controls";
import { IconArrowLeft, IconChevronRight, IconClock, IconDoc, IconUsers } from "../components/icons";

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeFromPath(new URL(request.url).pathname);
  const path = withLang(`/api/site/stories/${encodeURIComponent(params.publicId)}`, locale);
  try {
    // 404/503 的口径由 loadOr404 定（和其他页面同一套），这一页只多管一件事：已合并的事件要跳过去。
    return { story: await loadOr404<StoryDetail>(path, { signal: request.signal, redirect: "manual" }) };
  } catch (error) {
    if (error instanceof ApiRedirect && error.status === 308) {
      const target = (error.body as { mergedInto?: string } | null)?.mergedInto;
      if (target) throw redirect(`${locale === "en" ? "/en" : ""}/story/${encodeURIComponent(target)}`, 308);
    }
    throw error;
  }
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  if (!loaderData) return [{ title: titled(c.notFoundTitle) }, { name: "robots", content: "noindex" }];
  const s = loaderData.story;
  // fallback 模式下真回退中文的事件：head 里用英文兜底句，不把中文塞进 <title>/og:description。
  const noEnglish = locale === "en" && s.textLocale !== "en";
  return pageMeta({
    title: noEnglish ? c.metaNoEnglishTitle : s.title,
    description: noEnglish ? c.metaNoEnglishDescription : (s.digest ?? s.summary)?.slice(0, 150) ?? c.metaDesc(String(s.sourceCount), String(s.reportCount)),
    path: `/story/${s.publicId}`,
    image: `/og/stories/${s.publicId}.png`,
    // 标题、摘要/导读与最新进展都已由读取层按 /en 投影；真实回退中文时才把语种标在节点上。
    noindex: !s.indexable || (locale === "en" && strictEnglish() && s.textLocale !== "en"),
    enAvailable: s.textLocale === "en",
    type: "article",
    locale,
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: c.crumbHot, path: "/hot" }, { name: noEnglish ? c.metaNoEnglishTitle : s.title, path: `/story/${s.publicId}` }]),
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=120" };
}

/** 状态徽标的颜色是版式决定，不随语言变；词在字典里（copy.status）。 */
const STATUS = { active: "hot", watching: "amber", settled: "neutral" } as const;

// Section anchors keep the old page's ids so shared links still land in the right place.
const SECTIONS = { overview: "event-overview", reports: "event-reports", heat: "event-heat" } as const;
type SectionKey = keyof typeof SECTIONS;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A main-column card: 17px title, 24px padding. */
function Panel({ id, title, sub, right, children, className = "" }: { id?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`card scroll-mt-[64px] p-5 lg:p-6 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-[650] leading-[1.5] text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-[12.5px] text-ink-4">{sub}</p>}
        </div>
        {right && <div className="shrink-0 text-[11.5px] text-ink-4">{right}</div>}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/** A rail card: 14px title, 22px padding. */
function RailCard({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 lg:p-[22px] ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-[650] text-ink">{title}</h2>
        {right && <span className="num text-[11.5px] text-ink-4">{right}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Highlights the section nav entry whose section is under the sticky bar. */
function useActiveSection(keys: SectionKey[]): [SectionKey, (k: SectionKey) => void] {
  const [active, setActive] = useState<SectionKey>("overview");
  useEffect(() => {
    const els = keys.map((k) => document.getElementById(SECTIONS[k])).filter((e): e is HTMLElement => !!e);
    const onScroll = () => {
      let cur: SectionKey = keys[0]!;
      for (const [i, el] of els.entries()) if (el.getBoundingClientRect().top <= 96) cur = keys[i]!;
      // The last section may never reach the bar; at the bottom of the page it is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = keys[keys.length - 1]!;
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [keys.join()]);
  const go = (k: SectionKey) => {
    const el = document.getElementById(SECTIONS[k]);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    history.replaceState(history.state, "", `#${SECTIONS[k]}`);
  };
  return [active, go];
}

/**
 * 相对时间的措辞，按页面语言取词（zh/en 都走字典）。阈值与 lib/format.ts 的 relativeTime 一致，
 * 超过 30 天落到具体日期——中文页输出与 relativeTime 逐字相同；共享文件不动，这里只管取词。
 */
function relTime(iso: string, locale: Locale): string {
  const c = copy[locale];
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return c.relJustNow;
  const m = Math.floor(s / 60);
  if (m < 60) return c.relMinutes(String(m));
  const h = Math.floor(m / 60);
  if (h < 24) return c.relHours(String(h));
  const d = Math.floor(h / 24);
  if (d < 30) return c.relDays(String(d));
  return c.relDate(beijingDate(iso), beijingDate(Date.now()));
}

/** One report on the story timeline: time, source and marks, title, a summary that opens on demand. */
function TimelineRow({ r }: { r: StoryReportView }) {
  const locale = useLocale();
  const c = copy[locale];
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [r.summary, open]);
  return (
    <li className="grid gap-x-3 border-b border-line-soft py-4 last:border-b-0 lg:grid-cols-[48px_minmax(0,1fr)]">
      <time dateTime={r.publishedAt} className="mono text-[12px] leading-[20px] text-ink-4">
        {beijingTime(r.publishedAt)}
      </time>
      <div className="min-w-0">
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] leading-[20px] text-ink-4 lg:mt-0">
          <span className="min-w-0 truncate">{r.source.name.replace(/（RSS）|（网页）|（API）/g, "")}</span>
          {r.selected && <SelectedBadge />}
        </div>
        <Link to={localeAppPath(`/items/${r.id}`, locale)} prefetch="intent" className="mt-1 block text-[16px] font-[650] leading-[1.6] text-ink transition-colors hover:text-accent lg:text-[15.5px]">
          {r.title}
        </Link>
        {r.summary && (
          <>
            {/* 两行截断只在浏览器真能跑脚本时生效：那个「展开摘要」的按钮要靠客户端测量才会出现，
                关掉 JavaScript 的读者若被截断就没有任何出路（`root.tsx` 的 noscript 告示承诺过
                「事件页照常可读」）。不认识 `scripting` 这个媒体特性的浏览器整条规则不匹配，
                于是默认就是「不截断」——降级方向是对的。 */}
            <p ref={ref} className={`mt-1 text-[14px] leading-[1.75] text-ink-3 ${open ? "" : "[@media(scripting:enabled)]:line-clamp-2"}`}>
              {r.summary}
            </p>
            {(clamped || open) && (
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-[12.5px] text-note transition-colors hover:text-accent">
                {open ? c.collapseSummary : c.expandSummary}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

type Filter = "all" | "official" | "selected";

/**
 * 左上角写明返回到哪里（源站 2026-10-02 的规则）：`?from=` 优先，其次站内 `document.referrer`，
 * 都判不出就还是热点榜。`from` 读自 `useSearchParams`，服务端与水合后的第一帧是同一个值；
 * `referrer` 服务端读不到，只在 effect 里读，所以它最多晚一帧把文案改准，不会让两端首帧不同。
 */
function useBackPlace(): { name: string; to: string; hard: boolean } {
  const locale = useLocale();
  const c = copy[locale];
  const [params] = useSearchParams();
  const from = params.get("from");
  const [referred, setReferred] = useState<string | null>(null);
  useEffect(() => {
    if (from) return;
    try {
      const ref = new URL(document.referrer);
      if (ref.origin === window.location.origin) setReferred(`${ref.pathname}${ref.search}`);
    } catch {
      // 直接打开，或来路解析不出：留在热点榜
    }
  }, [from]);
  // backPlace（共享 lib）折出的名字是中文的：英文页在这里对译，词典没收录的名字原样展示。
  // 兜底落点同样带语言前缀：/en 的事件页判不出去处时回英文的热点榜。
  const place = backPlace(from) ?? backPlace(referred) ?? { name: c.backFallback, to: localeAppPath("/hot", locale), hard: false };
  return { ...place, name: (c.backNames as Record<string, string>)[place.name] ?? place.name };
}

export default function StoryPage() {
  const { story } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const back = useBackPlace();
  const [filter, setFilter] = useState<Filter>("all");
  // 排序选择存在这台浏览器里（lib/local-state.ts 的 timelineOrder）。首帧仍按默认的最新在前：
  // 服务端不知道读者的偏好，客户端如果在水合的第一帧就换成「最早在前」，两边的 DOM 顺序就不一样了。
  // 所以到挂载之后再把它接上，代价是那几百毫秒里列表还是默认顺序，换个事件页再看就一直是读者的选择了。
  const [order, setOrder] = useState<TimelineOrder>("desc");
  useEffect(() => {
    setOrder(getTimelineOrder());
  }, []);
  const chooseOrder = (next: TimelineOrder) => {
    setOrder(next);
    setTimelineOrder(next);
  };
  // A settled story nobody watched (history pages) has no heat to explain or chart.
  const observed = story.status !== "settled" || story.heat.length > 0 || story.whyHot.participants48h > 0 || story.whyHot.rank !== null;
  const sectionKeys: SectionKey[] = observed ? ["overview", "reports", "heat"] : ["overview", "reports"];
  const [activeSection, goSection] = useActiveSection(sectionKeys);
  const counts = {
    all: story.timeline.length,
    official: story.timeline.filter((r) => r.source.firstParty).length,
    selected: story.timeline.filter((r) => r.selected).length,
  };
  const days = useMemo(() => {
    const list = story.timeline.filter((r) => (filter === "official" ? r.source.firstParty : filter === "selected" ? r.selected : true));
    const sorted = [...list].sort((a, b) => (order === "desc" ? Date.parse(b.publishedAt) - Date.parse(a.publishedAt) : Date.parse(a.publishedAt) - Date.parse(b.publishedAt)));
    const out: Array<{ day: string; rows: StoryReportView[] }> = [];
    for (const r of sorted) {
      const d = beijingDate(r.publishedAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.rows.push(r);
      else out.push({ day: d, rows: [r] });
    }
    return out;
  }, [story.timeline, filter, order]);
  // Same control as the timeline, extended to the developments panel (upstream 3343fe2): the newest event
  // was always first, so a reader following an old story had to scroll to the bottom of its history.
  // The highlight is chosen by date, not by array index — a page fetched for an archived story may not
  // have its newest development at position 0.
  const developments = useMemo(() => [...story.developments].sort((a, b) =>
    order === "desc" ? Date.parse(b.firstReportAt) - Date.parse(a.firstReportAt) : Date.parse(a.firstReportAt) - Date.parse(b.firstReportAt)
  ), [story.developments, order]);
  const newestDevelopmentAt = story.developments.reduce((at, d) => (Date.parse(d.firstReportAt) > Date.parse(at) ? d.firstReportAt : at), story.developments[0]?.firstReportAt ?? "");
  const newest = story.timeline.reduce<StoryReportView | null>((a, b) => (!a || Date.parse(b.publishedAt) > Date.parse(a.publishedAt) ? b : a), null);
  const overview = story.digest
    ? { label: c.overviewLabels.digest, text: story.digest, note: story.digestUpdatedAt ? c.digestNote(relTime(story.digestUpdatedAt, locale)) : c.digestNotePlain }
    : story.summary
      ? { label: c.overviewLabels.facts, text: story.summary, note: null }
      : story.excerpt
        ? { label: c.overviewLabels.excerpt, text: story.excerpt.text, note: c.excerptNote(story.excerpt.sourceName) }
        : null;
  const showOfficial = () => {
    setFilter("official");
    goSection("reports");
  };

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <nav aria-label={c.breadcrumbAria} className="flex items-center gap-2.5 pb-4 pt-5 text-[12px] text-ink-4 lg:pb-5 lg:pt-4">
        {back.hard ? (
          // 来路是首页：`<Link to="/">` 在 basename 下会解成裸 `/geohot`，客户端匹配器认不出，
          // 读者看到 404 而地址栏是对的。这一格交回浏览器做真导航（与首页筛选 chip 同一个处理）。
          <a href={publicPath(back.to)} className="inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:text-ink">
            <IconArrowLeft size={15} /> {back.name}
          </a>
        ) : (
          <Link to={back.to} className="inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:text-ink">
            <IconArrowLeft size={15} /> {back.name}
          </Link>
        )}
        <span className="h-3 w-px bg-line-strong" aria-hidden="true" />
        <span>{c.breadcrumbHere}</span>
      </nav>

      <header className="max-w-[960px]">
        <div className="flex items-center gap-2 text-[12px] text-ink-4">
          {c.kicker}
          <Badge tone={STATUS[story.status]}>{c.status[story.status]}</Badge>
        </div>
        {/* 事件标题在读取层可能是中文（有中文稿）也可能是信源原文（没有中文稿的那类事件页），
            英文页的 <html lang="en"> 下不能一律当英文念：标题含中文时把语种写在它自己身上（WCAG 3.1.2）。 */}
        <h1 lang={locale === "en" && hasChineseCopy(story.title) ? "zh" : undefined} className="mt-2.5 text-[27px] font-bold leading-[1.5] tracking-[-0.01em] text-ink lg:mt-3 lg:text-[36px] lg:font-[730]">{story.title}</h1>
        {!story.indexable && (
          // 事件页照旧能打开（下面的报道就是记录），但这句话得替读者说清楚：这一页没有任何本站写的中文。
          <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2 text-[12.5px] leading-[1.7] text-ink-3">
            <span>{c.untranslatedNote}</span>
            <Link to={localeAppPath("/hot", locale)} className="text-accent hover:underline">{c.untranslatedLink}</Link>
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <IconDoc size={15} className="text-ink-4" />
            <b className="num font-semibold text-ink">{story.reportCount}</b>{c.reportUnit}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconUsers size={15} className="text-ink-4" />
            <b className="num font-semibold text-ink">{story.sourceCount}</b>{c.sourceUnit}
          </span>
          {story.latestAt && (
            <span className="inline-flex items-center gap-1.5" suppressHydrationWarning>
              <IconClock size={15} className="text-ink-4" />
              {c.updatedAgo(relTime(story.latestAt, locale))}
            </span>
          )}
        </div>
      </header>

      {/* 事件标题、提要与报道标题已按 /en 投影；只有整条事件仍回退中文时才标注。
          中文页永不渲染。 */}
      {locale === "en" && story.textLocale !== "en" && <MissingEnglishNotice className="mt-1" />}

      <div className="sticky top-0 z-20 -mx-4 mt-5 bg-bg/90 px-4 py-2 backdrop-blur-md lg:mx-0 lg:px-0">
        <PillTabs
          size="sm"
          layoutId="story-sections"
          label={c.navAria}
          active={activeSection}
          onSelect={(k) => goSection(k as SectionKey)}
          items={[
            { key: "overview", label: c.tabOverview },
            { key: "reports", label: c.tabReports, count: story.reportCount },
            ...(observed ? [{ key: "heat", label: c.tabHeat }] : []),
          ]}
        />
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:mt-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6 2xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* On phones the main column dissolves so the rail's cards can sit between its sections. */}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
          <Panel id={SECTIONS.overview} title={c.overviewTitle} right={overview?.label} className="order-1">
            {overview ? (
              <>
                <p className="whitespace-pre-line text-[15px] leading-[1.85] text-ink-2">{overview.text}</p>
                {overview.note && (
                  <p className="mt-2 text-[12px] text-ink-4" suppressHydrationWarning>
                    {overview.note}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[13.5px] text-ink-4">{c.overviewEmpty}</p>
            )}
            {story.latest && (
              <div className="-mx-5 mt-5 border-t border-line-soft px-5 pt-4 lg:-mx-6 lg:px-6">
                <div className="flex items-center gap-2.5 text-[12px]">
                  <span className="font-semibold text-ink">{c.latestLabel}</span>
                  {story.latestAt && <span className="num text-ink-4">{monthDayTime(story.latestAt, locale)}</span>}
                </div>
                {newest ? (
                  <Link to={localeAppPath(`/items/${newest.id}`, locale)} className="group mt-1.5 inline text-[14px] leading-[1.7] text-ink-2 transition-colors hover:text-accent">
                    {story.latest}
                    <IconChevronRight size={14} className="ml-0.5 inline -translate-y-px text-ink-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <p className="mt-1.5 text-[14px] leading-[1.7] text-ink-2">{story.latest}</p>
                )}
              </div>
            )}
          </Panel>

          {story.developments.length > 1 && (
            <Panel
              title={c.devTitle}
              sub={c.devCount(String(story.developments.length))}
              className="order-3"
              right={
                <Select value={order} onChange={(e) => chooseOrder(e.target.value as TimelineOrder)} aria-label={c.devSortAria}>
                  <option value="desc">{c.sortDesc}</option>
                  <option value="asc">{c.sortAsc}</option>
                </Select>
              }
            >
              <ol className="relative space-y-4 pl-5 before:absolute before:bottom-2 before:left-[3px] before:top-2 before:w-px before:bg-line">
                {developments.map((d) => (
                  <li key={d.factId} className="relative">
                    <span className={`absolute -left-5 top-[7px] size-[7px] rounded-full ring-4 ring-surface ${d.firstReportAt === newestDevelopmentAt ? "bg-accent" : "bg-line-strong"}`} aria-hidden="true" />
                    <div className="num text-[12px] text-ink-4">
                      {monthDayTime(d.firstReportAt, locale)} · {c.reportsCount(String(d.reportCount))}
                    </div>
                    <Link to={localeAppPath(`/items/${d.representative.id}`, locale)} className="mt-0.5 block text-[15px] font-semibold leading-snug text-ink transition-colors hover:text-accent">
                      {d.title}
                    </Link>
                    <div className="mt-0.5 truncate text-[12.5px] text-ink-4">
                      {shortSourceName(d.representative.source.name)}{c.sourceJoiner}{d.representative.title}
                    </div>
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          <Panel
            id={SECTIONS.reports}
            title={c.tabReports}
            sub={c.reportsSub}
            className="order-4"
            right={
              <Select value={order} onChange={(e) => chooseOrder(e.target.value as TimelineOrder)} aria-label={c.reportsSortAria}>
                <option value="desc">{c.sortDesc}</option>
                <option value="asc">{c.sortAsc}</option>
              </Select>
            }
          >
            <PillTabs
              size="xs"
              layoutId="story-report-filter"
              label={c.filterAria}
              active={filter}
              onSelect={(k) => setFilter(k as Filter)}
              items={[
                { key: "all", label: c.filterAll, count: counts.all },
                { key: "official", label: c.filterOfficial, count: counts.official },
                { key: "selected", label: c.filterSelected, count: counts.selected },
              ]}
            />
            {days.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-ink-4">{c.filterEmpty}</p>
            ) : (
              days.map(({ day, rows }) => (
                <div key={day}>
                  <div className="pb-0.5 pt-5 text-[14px] font-semibold text-ink">{c.dayHeading(day)}</div>
                  <ol>
                    {rows.map((r) => (
                      <TimelineRow key={r.id} r={r} />
                    ))}
                  </ol>
                </div>
              ))
            )}
            {story.reportCount > story.timeline.length && (
              <p className="pt-3 text-center text-[12px] text-ink-4">
                {c.timelineCapped(String(story.timeline.length), String(story.reportCount))}
              </p>
            )}
          </Panel>

          {observed && (
            <Panel id={SECTIONS.heat} title={c.heatTitle} className="order-5">
              <HeatChart points={story.heat} />
            </Panel>
          )}

          {story.related.length > 0 && (
            <Panel title={c.relatedTitle} className="order-6">
              <ul className="-my-1 divide-y divide-line-soft">
                {story.related.map((r) => (
                  <li key={r.publicId}>
                    <Link to={localeAppPath(`/story/${r.publicId}`, locale)} className="group flex items-baseline gap-3 py-3">
                      <span className="shrink-0 text-[12px] text-ink-4">{r.relation === "storyline" ? c.relatedStoryline : c.relatedOther}</span>
                      <span className="min-w-0 flex-1 text-[14.5px] font-medium text-ink-2 transition-colors group-hover:text-accent">{r.title}</span>
                      <IconChevronRight size={14} className="shrink-0 self-center text-ink-4" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <aside className="order-2 flex min-w-0 flex-col gap-4 lg:order-none lg:gap-5">
          {observed && (
            <RailCard title={c.whyHotTitle}>
              <p className="text-[12.5px] leading-[1.75] text-ink-3">
                {c.whyHotPre}
                <b className="num font-semibold text-ink">{story.whyHot.participants48h}</b>
                {c.whyHotMid}
                <b className="num font-semibold text-ink">{story.whyHot.newParticipants6h}</b>
                {c.whyHotPost}
              </p>
              {!story.whyHot.observationComplete && <p className="mt-2 text-[12px] leading-relaxed text-ink-4">{c.whyHotIncomplete}</p>}
              <p className="mt-2 text-[12px] text-ink-4">
                <span className="num">{story.whyHot.recentReports24h}</span>{c.recentReportsUnit}
                {story.whyHot.rank && (
                  <>
                    <span className="mx-1">·</span>
                    <Link to={localeAppPath("/hot", locale)} className="text-accent hover:underline">
                      {c.rankOnBoard(String(story.whyHot.rank))}
                    </Link>
                  </>
                )}
              </p>
            </RailCard>
          )}
          {story.officialReports.length > 0 && (
            <RailCard title={c.filterOfficial} right={c.countShort(String(counts.official || story.officialReports.length))}>
              <p className="text-[12px] text-ink-4">{c.officialHint}</p>
              <ul className="mt-1 divide-y divide-line-soft">
                {story.officialReports.slice(0, 5).map((r) => (
                  <li key={r.id} className="py-3">
                    <div className="truncate text-[11.5px] text-ink-4">{r.source.name}</div>
                    <Link to={localeAppPath(`/items/${r.id}`, locale)} className="group mt-1 block text-[13.5px] font-semibold leading-[1.6] text-ink transition-colors hover:text-accent">
                      {r.title}
                      <IconChevronRight size={13} className="ml-0.5 inline -translate-y-px text-ink-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
              {counts.official > 0 && (
                <button type="button" onClick={showOfficial} className="text-[12px] text-ink-4 transition-colors hover:text-accent">
                  {c.officialFilterCta}
                </button>
              )}
            </RailCard>
          )}
          <RailCard title={c.recordsTitle} className="hidden lg:block">
            <dl className="space-y-2 text-[12.5px]">
              {story.firstReportAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-4">{c.firstReportLabel}</dt>
                  <dd className="num text-ink-2">
                    <time dateTime={story.firstReportAt}>{monthDayTime(story.firstReportAt, locale)}</time>
                  </dd>
                </div>
              )}
              {story.latestAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-4">{c.latestUpdateLabel}</dt>
                  <dd className="num text-ink-2">
                    <time dateTime={story.latestAt}>{monthDayTime(story.latestAt, locale)}</time>
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-3 border-t border-line-soft pt-3 text-[12px] leading-relaxed text-ink-4">{c.recordsNote}</p>
          </RailCard>
        </aside>
      </div>
    </div>
  );
}
