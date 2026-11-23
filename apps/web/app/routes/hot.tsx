import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/hot";
import type { HotEntryView, HotResponse } from "@aihot/contracts/site";
import { loadOr404, withLang } from "../lib/api.server";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/hot";
import { shortSourceName } from "../lib/format";
import { Badge } from "../components/ui/Badge";
import { EmptyState, MoreLink } from "../components/ui/Page";
import { IconChevronDown, IconInfo } from "../components/icons";
import { Sparkline } from "../features/hot/Sparkline";
import { Faces } from "../features/hot/Faces";
import { Delta } from "../features/hot/Delta";
import { useLivePublicData } from "../lib/use-live-public-data";

export async function loader({ request }: { request: Request }) {
  const locale = localeFromPath(new URL(request.url).pathname);
  return { hot: await loadOr404<HotResponse>(withLang("/api/site/hot", locale), { signal: request.signal }) };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  const hot = loaderData?.hot;
  // 榜上空着的时候不能说"10 个事件"——那是一句数据不支持的话，页面元数据里也一样。
  const description = hot && hot.entries.length > 0
    ? c.metaWithEntries(String(hot.entries.length), String(hot.windowHours))
    : c.metaEmpty("48");
  return pageMeta({
    title: c.metaTitle,
    description,
    path: "/hot",
    image: "/og/pages/hot.png",
    locale,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=60" };
}

/** 徽标的颜色是版式决定，不随语言变；词在字典里（copy.badges）。 */
const BADGE_TONE: Record<HotEntryView["badges"][number], "hot" | "accent" | "amber"> = {
  surge: "hot",
  new: "accent",
  rising: "amber",
};

const RANK_COLOR = ["text-rank-1", "text-rank-2", "text-rank-3"];
const rankColor = (rank: number) => RANK_COLOR[rank - 1] ?? "text-rank-rest";
const pad = (rank: number) => String(rank).padStart(2, "0");

/** "TechCrunch、The Verge 等 4 个来源 · 7 位参与者". */
function Voices({ e }: { e: HotEntryView }) {
  const locale = useLocale();
  const c = copy[locale].voices;
  const names = (locale === "en" && e.sourceNamesEn?.length ? e.sourceNamesEn : e.sourceNames).slice(0, 2).map(shortSourceName);
  const shown = names.join(c.nameJoiner);
  return (
    <span className="min-w-0 text-[12.5px] leading-snug text-ink-4">
      {/* Lines break between the phrases, never inside one. */}
      <span className="whitespace-nowrap">
        {names.length > 0 && <span className="text-ink-3">{shown}</span>}
        {e.sourceCount > names.length
          ? c.sourcesAmong(String(e.sourceCount))
          : names.length ? c.sourcesReported : c.sourcesPlain(String(e.sourceCount))}
      </span>
      <span className="mx-1.5 text-line-strong">·</span>
      <span className="whitespace-nowrap">
        <span className="num">{e.participantCount}</span>
        {copy[locale].participantUnit}
      </span>
    </span>
  );
}

function Badges({ e }: { e: HotEntryView }) {
  const c = copy[useLocale()].badges;
  return e.badges.map((b) => (
    <Badge key={b} tone={BADGE_TONE[b]} title={c[b].hint}>
      {c[b].label}
    </Badge>
  ));
}

/** The whole card opens the event; the title carries the link and stretches over the card. */
function StoryLink({ e, className }: { e: HotEntryView; className: string }) {
  const locale = useLocale();
  return (
    <Link to={localeAppPath(`/story/${e.story.publicId}`, locale)} prefetch="intent" className={`transition-colors after:absolute after:inset-0 after:content-[''] ${className}`}>
      <span lang={locale === "en" && hasChineseCopy(e.story.title) ? "zh-Hans" : undefined}>{e.story.title}</span>
    </Link>
  );
}

/**
 * The lead card's picture slot when the story has no picture of its own: its day of heat, drawn large
 * on a faint wash, with where it peaked. Without enough comparable hours the text takes the width.
 */
function HeatPanel({ e }: { e: HotEntryView }) {
  const locale = useLocale();
  const c = copy[locale].heatPanel;
  const seen = e.spark.filter((v): v is number => v !== null);
  const peak = Math.max(...seen);
  const peakAt = e.spark.findIndex((v) => v === peak);
  return (
    <div className="order-first flex aspect-[2/1] flex-col rounded-panel bg-accent-softer p-4 ring-1 ring-inset ring-line-soft xl:order-none xl:aspect-[16/10] dark:bg-accent-soft">
      <div className="flex items-baseline justify-between text-[11.5px] text-ink-4">
        <span className="font-semibold text-ink-3">{c.title}</span>
        <span>
          {c.peak} <span className="mono text-ink-2">{Math.round(peak)}</span>
          {peakAt >= 0 && <span> · {peakAt === e.spark.length - 1 ? c.current : c.hoursAgo(String(e.spark.length - 1 - peakAt))}</span>}
        </span>
      </div>
      <Sparkline values={e.spark} area stretch className="mt-2 min-h-0 w-full flex-1 text-accent" />
      <div className="mt-2 flex justify-between text-[11px] text-ink-4">
        <span>{c.startLabel}</span>
        <span>{c.now}</span>
      </div>
    </div>
  );
}

/** No. 1: the event people are talking about most, with its picture, digest, latest turn and day of heat. */
function Lead({ e }: { e: HotEntryView }) {
  const locale = useLocale();
  const c = copy[locale];
  const panel = !e.cover && e.spark.filter((v) => v !== null).length >= 3;
  return (
    <article className="card card-hover group relative flex flex-col overflow-hidden p-5 sm:p-6">
      <div className="flex items-center gap-2.5">
        <span className={`mono text-[12px] font-bold tracking-[0.16em] ${rankColor(e.rank)}`}>NO.{pad(e.rank)}</span>
        <Badges e={e} />
        <Delta trend={e.trend} pct={e.trendPct} className="ml-auto" />
      </div>
      <div className={`mt-4 grid gap-5 ${e.cover || panel ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)] xl:gap-7" : ""}`}>
        <div className="min-w-0">
          <h2 className="text-[21px] font-bold leading-[1.4] tracking-[-0.01em] text-ink sm:text-[23px] lg:text-[25px] lg:leading-[1.38]">
            <StoryLink e={e} className="group-hover:text-accent" />
          </h2>
          {e.summary && <p className="mt-3 line-clamp-3 text-[14px] leading-[1.75] text-ink-3">{e.summary}</p>}
        </div>
        {e.cover ? (
          <div className="order-first overflow-hidden well rounded-panel xl:order-none">
            <img src={e.cover.url} srcSet={e.cover.srcSet} sizes="(min-width: 1280px) calc(28vw - 96px), (min-width: 1024px) calc(58vw - 180px), (min-width: 640px) 568px, calc(100vw - 74px)" width={e.cover.width ?? undefined} height={e.cover.height ?? undefined} alt="" loading="eager" fetchPriority="high" decoding="async" className="aspect-[16/9] size-full object-cover transition-transform duration-500 group-hover:scale-[1.02] xl:aspect-[16/10]" />
          </div>
        ) : (
          panel && <HeatPanel e={e} />
        )}
      </div>
      {/* Side by side while the card is wide enough; on a narrow card the day of heat and the index
          move under the voices, to the right, instead of squeezing them into a column. */}
      <div className="mt-auto flex flex-wrap items-end gap-x-6 gap-y-4 pt-5">
        <div className="min-w-0 flex-[1_1_18rem] space-y-2.5">
          {e.latest && (
            <p className="line-clamp-2 text-[13px] leading-[1.7] text-ink-2">
              <span className="mr-2 text-[12px] font-semibold text-accent">{c.latestProgress}</span>
              {e.latest}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Faces participants={e.participants} total={e.participantCount} size={24} />
            <Voices e={e} />
          </div>
        </div>
        <div className="flex w-full shrink-0 items-end justify-between gap-5 sm:ml-auto sm:w-auto sm:justify-end">
          {!panel && <Sparkline values={e.spark} area className="h-10 w-[140px] text-accent" />}
          <div className="text-right">
            <div className="mono text-[34px] font-semibold leading-none tracking-[-0.03em] text-ink">{Math.round(e.heat)}</div>
            <div className="mt-1 text-[11.5px] text-ink-4">{c.heatIndex}</div>
          </div>
        </div>
      </div>
    </article>
  );
}

/** No. 2 and 3: the same card, smaller, without the picture. */
function Runner({ e }: { e: HotEntryView }) {
  const locale = useLocale();
  const c = copy[locale];
  return (
    <article className="card card-hover group relative flex flex-col px-5 py-4">
      <div className="flex items-center gap-2.5">
        <span className={`mono text-[12px] font-bold tracking-[0.16em] ${rankColor(e.rank)}`}>NO.{pad(e.rank)}</span>
        <Badges e={e} />
        <Delta trend={e.trend} pct={e.trendPct} className="ml-auto" />
      </div>
      <h2 className="mt-2.5 line-clamp-2 text-[16px] font-[650] leading-[1.5] text-ink">
        <StoryLink e={e} className="group-hover:text-accent" />
      </h2>
      {e.summary && <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.7] text-ink-3 lg:line-clamp-1">{e.summary}</p>}
      <div className="mt-auto flex items-end justify-between gap-4 pt-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Faces participants={e.participants} total={e.participantCount} size={20} />
          <span className="text-[12px] text-ink-4">
            <span className="whitespace-nowrap"><span className="num">{e.sourceCount}</span>{c.sourceUnit}</span> ·{" "}
            <span className="whitespace-nowrap"><span className="num">{e.participantCount}</span>{c.participantUnit}</span>
          </span>
        </div>
        <div className="flex items-end gap-3">
          <Sparkline values={e.spark} className="h-7 w-[92px] text-accent" />
          <span className="mono text-[24px] font-semibold leading-none tracking-[-0.02em] text-ink">{Math.round(e.heat)}</span>
        </div>
      </div>
    </article>
  );
}

/** No. 4–10: a row each, with a line of the digest, faces, the day of heat and the index. */
function Row({ e }: { e: HotEntryView }) {
  const locale = useLocale();
  const c = copy[locale];
  return (
    <li className="group relative grid grid-cols-[30px_minmax(0,1fr)] items-start gap-x-3 px-4 py-3 transition-colors hover:bg-bg-sunk/70 sm:px-5 lg:grid-cols-[44px_minmax(0,1fr)_auto_104px_76px] lg:items-center lg:gap-x-6 lg:px-6 lg:py-3.5 dark:hover:bg-bg-muted/40">
      {/* 名次那两个字是给眼睛看的简写；`role="img"` 让这个 span 可以被命名（generic 角色不允许带
          aria-label，读屏会只念出「04」），与 `components/ui/Score.tsx` 那枚分数徽标同一个写法。 */}
      <span role="img" className={`mono text-[16px] font-semibold leading-[24px] lg:text-[17px] ${rankColor(e.rank)}`} aria-label={c.rankAria(String(e.rank))}>
        {pad(e.rank)}
      </span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-[650] leading-[1.55] text-ink">
          <StoryLink e={e} className="group-hover:text-accent" />
          {e.badges.length > 0 && (
            <span className="ml-2 inline-flex translate-y-[-2px] gap-1 align-middle">
              <Badges e={e} />
            </span>
          )}
        </h3>
        {e.summary && <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.65] text-ink-4 lg:line-clamp-1">{e.summary}</p>}
        <div className="mt-2 flex items-center gap-2.5 lg:hidden">
          <Faces participants={e.participants} total={e.participantCount} size={20} />
          <span className="text-[12px] text-ink-4">
            <span className="num">{e.sourceCount}</span>{c.sourceUnit}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span className="mono text-[17px] font-semibold leading-none text-ink">{Math.round(e.heat)}</span>
            <Delta trend={e.trend} pct={e.trendPct} />
          </span>
        </div>
      </div>
      <div className="hidden items-center gap-2.5 lg:flex">
        <Faces participants={e.participants} total={e.participantCount} size={20} />
      </div>
      <Sparkline values={e.spark} className="hidden h-7 w-[104px] text-accent lg:block" />
      <div className="hidden flex-col items-end gap-1 lg:flex">
        <span className="mono text-[20px] font-semibold leading-none tracking-[-0.02em] text-ink">{Math.round(e.heat)}</span>
        <Delta trend={e.trend} pct={e.trendPct} />
      </div>
    </li>
  );
}

export default function HotPage() {
  const { hot: initial } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const hot = useLivePublicData(initial, locale === "en" ? "/api/site/hot?lang=en" : "/api/site/hot");
  const [lead, ...rest] = hot.entries;
  const runners = rest.slice(0, 2);
  const others = rest.slice(2);
  return (
    <div className="pb-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-5 pt-5 lg:pt-1">
        <div>
          <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-hot">
            <span className="relative flex size-2" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-hot opacity-30" />
              <span className="relative inline-flex size-2 rounded-full bg-hot" />
            </span>
            {c.kicker}
          </div>
          <h1 className="mt-1.5 text-[24px] font-bold leading-[1.3] tracking-[-0.01em] text-ink lg:text-[26px]">{c.headline}</h1>
          {/* 空榜时原来的 `|| 10` 会念出一句"讨论最多的 10 个事件"，而榜上什么也没有。 */}
          <p className="mt-1.5 text-[13.5px] text-ink-3">
            {hot.entries.length > 0 ? (
              <>
                {c.leadFilledPre(String(hot.windowHours))}
                <span className="num">{hot.entries.length}</span>
                {c.leadFilledPost(String(hot.windowHours))}
              </>
            ) : (
              c.leadEmpty(String(hot.windowHours))
            )}
          </p>
        </div>
        {hot.computedAt && (
          <p className="text-[12px] text-ink-4">
            {c.updatedPre}
            <span className="num">{c.updatedAt(hot.computedAt)}</span>
            {c.updatedPost}
          </p>
        )}
      </header>
      {/* 读取层已按 /en 投影事件标题/摘要/进展；只有榜上真有条目回退中文时才标注。 */}
      {locale === "en" && hot.entries.some((e) => e.textLocale !== "en") && <p className={`text-[12.5px] text-ink-4 mt-1`}>{c.chineseNotice}</p>}

      {!lead ? (
        <div className="card rounded-sheet">
          {/* An empty board is a state, not a dead end: the strip on the home page has always offered
              「看今天的全部地理动态 →」, and this page — the one that strip links to — used to answer with
              two sentences and zero links (found by a real-browser pass, 2026-10-04). */}
          <EmptyState
            title={c.emptyTitle}
            action={
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                <MoreLink to={localeAppPath("/all", locale)}>{c.seeAll}</MoreLink>
                <MoreLink to={localeAppPath("/daily", locale)}>{c.latestBrief}</MoreLink>
              </div>
            }
          >
            {c.emptyBody}
          </EmptyState>
        </div>
      ) : (
        <>
          <section aria-label={c.topThree} className="grid gap-3 lg:grid-cols-12 lg:gap-4">
            <div className="grid lg:col-span-7 lg:row-span-2 xl:col-span-8">
              <Lead e={lead} />
            </div>
            {runners.map((e) => (
              <div key={e.story.publicId} className="grid lg:col-span-5 xl:col-span-4">
                <Runner e={e} />
              </div>
            ))}
          </section>

          {others.length > 0 && (
            <section aria-label={c.moreHot} className="mt-6 lg:mt-7">
              <div className="mb-3 flex items-baseline justify-between px-1">
                <h2 className="text-[15px] font-semibold text-ink">
                  {c.continueLabel} <span className="num font-normal text-ink-4">No.{pad(others[0]!.rank)}–{pad(others[others.length - 1]!.rank)}</span>
                </h2>
                <span className="hidden text-[12px] text-ink-4 lg:block">{c.legend}</span>
              </div>
              <ol className="card divide-y divide-line-soft overflow-hidden">
                {others.map((e) => (
                  <Row key={e.story.publicId} e={e} />
                ))}
              </ol>
            </section>
          )}
        </>
      )}

      <details className="disclosure group/method mt-8 text-[12px] text-ink-4">
        <summary className="flex items-center gap-1.5 py-1 transition-colors hover:text-ink-2">
          <IconInfo size={15} />
          {c.howTitle}
          <span className="ml-auto inline-flex items-center gap-0.5">
            <span className="group-open/method:hidden">{c.howShow}</span>
            <span className="hidden group-open/method:inline">{c.howHide}</span>
            <IconChevronDown size={13} className="transition-transform duration-200 group-open/method:rotate-180" />
          </span>
        </summary>
        <div className="max-w-[760px] space-y-2 pb-2 pl-[21px] pt-2 leading-[1.75] text-ink-3">
          <p>{c.how1}</p>
          <p>{c.how2}</p>
          <p>{c.how3}</p>
          <dl className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
            {(Object.keys(c.badges) as Array<keyof typeof c.badges>).map((key) => (
              <div key={key} className="flex items-center gap-1.5">
                <dt>
                  <Badge tone={BADGE_TONE[key]}>{c.badges[key].label}</Badge>
                </dt>
                <dd>{c.badges[key].hint}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    </div>
  );
}
