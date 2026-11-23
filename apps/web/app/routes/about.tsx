import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLoaderData } from "react-router";
import type { SiteStats } from "@aihot/contracts/site";
import { apiGet, withLang } from "../lib/api.server";
import { shortSourceName } from "../lib/format";
import { ABOUT } from "@aihot/industry/site";
import { organizationLd, pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale, type Locale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/about";
import { MissingEnglishNotice } from "../components/ui/ChineseNotice";
import { Kicker } from "../components/ui/Kicker";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";
import { SignalRiver, type RiverSource } from "../features/about/SignalRiver";
import { publicPath } from "../lib/public-path";
import type { Route } from "./+types/about";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

interface ContactSettings {
  /** The maker's X avatar through the image proxy, when the site follows that account. */
  makerAvatar?: string | null;
}

export async function loader({ request }: { request: Request }) {
  const locale = localeFromPath(new URL(request.url).pathname);
  // 这两个都是装饰，读不到不能带走整页（所以不是 loadOr404）。但"读不到"和"没有"是两件事：
  // 数字的位置空着会被读成"这个站没有内容"，所以把失败单独记下来，由页面自己说明。
  const [contact, stats] = await Promise.all([
    apiGet<ContactSettings>("/api/site/contact", { signal: request.signal }).catch((): ContactSettings => ({ makerAvatar: null })),
    apiGet<SiteStats>(withLang("/api/site/stats", locale), { signal: request.signal }).catch(() => null),
  ]);
  return { contact, stats, statsFailed: stats === null };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({
    title: c.metaTitle,
    description: c.metaDescription,
    path: "/about",
    image: "/og/pages/about.png",
    jsonLd: organizationLd(),
    locale,
  });
}

const NO_SOURCES: SiteStats["sampleSources"] = [];

/** 3.6 万 from ten thousand up, digits with separators below; English counts the same range in k（与 item.ts 字典的 wanToK 同一换算）. */
function figure(n: number, locale: Locale): { value: string; unit: string } {
  const wan = (n / 10_000).toFixed(1).replace(/\.0$/, "");
  return n >= 10_000
    ? locale === "en"
      ? { value: String(Math.round(Number(wan) * 10)), unit: copy[locale].wanUnit }
      : { value: wan, unit: copy[locale].wanUnit }
    : { value: n.toLocaleString("en-US"), unit: "" };
}

function Figure({ n, unit }: { n: number; unit: string }) {
  const f = figure(n, useLocale());
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="num text-[30px] font-black leading-none tracking-[-0.03em] text-ink xl:text-[36px]">{f.value}</span>
      <span className="text-[13px] text-ink-3">
        {f.unit}
        {unit}
      </span>
    </div>
  );
}

/** 信源种类在「采集」小注里的顺序；名字在字典里（copy.kindLabels）。 */
const KIND_ORDER = ["x_search", "rss", "web_list", "mp_account", "json_list"] as const;

/**
 * The stage columns' rules: one column on phones, two by two from sm, and from lg four in a row whose
 * edges fall on the river's stage boundaries.
 */
const STAGE_CELL = [
  "sm:pr-6 lg:pr-6",
  "border-t sm:border-l sm:border-t-0 sm:pl-6 lg:px-6",
  "border-t sm:pr-6 lg:border-l lg:border-t-0 lg:px-6",
  "border-t sm:border-l sm:pl-6 lg:border-t-0 lg:px-6",
];

interface Stage {
  no: string;
  title: string;
  figure: ReactNode;
  text: string;
  note: ReactNode;
}

function stagesOf(stats: SiteStats | null, locale: Locale): Stage[] {
  const c = copy[locale];
  const kinds = stats
    ? KIND_ORDER.filter((k) => stats.sourceKinds[k]).map((k) => `${c.kindLabels[k]} ${stats.sourceKinds[k]}`).join(" · ")
    : null;
  return [
    {
      no: "01",
      title: c.stageCollect,
      figure: stats && <Figure n={stats.sources} unit={c.unitSources} />,
      text: c.aboutSteps.collect,
      note: kinds,
    },
    {
      no: "02",
      title: c.stageStore,
      figure: stats && <Figure n={stats.items} unit={c.unitItems} />,
      text: c.aboutSteps.store,
      note: stats && c.dayCollected(stats.day.collected.toLocaleString("en-US")),
    },
    {
      no: "03",
      title: c.stageSelect,
      figure: stats && <Figure n={stats.selected} unit={c.unitSelected} />,
      text: c.aboutSteps.select,
      note: stats && c.daySelected(String(stats.day.selected)),
    },
    {
      no: "04",
      title: c.stagePublish,
      figure: stats && <Figure n={stats.dailies} unit={c.unitDailies} />,
      text: c.aboutSteps.publish,
      note: c.subscribeNote,
    },
  ];
}

/** The maker's round avatar before the greeting; it steps aside if the image fails. */
function MakerFace({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const c = copy[useLocale()];
  if (failed) return null;
  return <img src={src} alt={c.avatarAlt(name)} width={48} height={48} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-full bg-bg-sunk object-cover ring-1 ring-line xl:size-12" />;
}

/** The optional maker block (ABOUT.maker): the greeting; contact moved to the feedback page (QR codes retired 2026-10-31). */
function Maker({ maker }: { maker: NonNullable<typeof ABOUT.maker> }) {
  const locale = useLocale();
  const c = copy[locale];
  const name = locale === "en" ? c.makerNameEn : maker.name;
  return (
    <section aria-labelledby="maker" className="mt-20 grid gap-10 xl:mt-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div>
        <Kicker>{c.makerKicker}</Kicker>
        <h2 id="maker" className="mt-4 flex items-center gap-3.5 text-[26px] font-black leading-[1.3] tracking-[-0.02em] text-ink xl:gap-4 xl:text-[34px]">
          <MakerFace src={publicPath("/images/maker-xinchen.jpg")} name={name} />
          <span>
            {c.makerHi}
            <span lang={locale === "zh" ? "zh-Hans" : undefined} className="whitespace-nowrap text-accent">{name}</span>
          </span>
        </h2>
        <div className="mt-5 space-y-4 text-[15.5px] leading-[1.9] text-ink-2 xl:text-[16.5px]">
          {c.aboutGreeting.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="text-ink-3">
            {c.madeChangesPre}
            <Link to={localeAppPath("/changelog", locale)} className="text-accent hover:underline">
              {c.changelogLink}
            </Link>
            {c.madeChangesMid}
            <Link to={localeAppPath("/feedback", locale)} className="text-accent hover:underline">
              {c.feedbackLink}
            </Link>
            {c.madeChangesPost}
          </p>
        </div>
      </div>
    </section>
  );
}

/** The latest 精选 under the river's paper; it moves on each time an item reaches the paper. */
function Latest({ item, className = "" }: { item: SiteStats["latest"][number] | undefined; className?: string }) {
  const locale = useLocale();
  const c = copy[locale];
  if (!item) return null;
  const title = locale === "en" ? item.titleEn ?? item.title : item.title;
  const source = locale === "en" ? item.sourceNameEn ?? item.source : item.source;
  return (
    <Link to={localeAppPath(`/items/${item.id}`, locale)} prefetch="intent" className={`group block ${className}`}>
      <span className="text-[11px] font-semibold tracking-[0.2em] text-accent">{c.latestSelected}</span>
      <span key={item.id} className="animate-fade-up mt-1.5 block">
        <span className="line-clamp-2 text-[13.5px] font-semibold leading-[1.55] text-ink transition-colors group-hover:text-accent">{title}</span>
        <span className="mt-1 block truncate text-[12px] text-ink-4">{shortSourceName(source)}</span>
      </span>
    </Link>
  );
}

export default function AboutPage() {
  const { stats, statsFailed } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const [focus, setFocus] = useState<number | null>(null);
  const [at, setAt] = useState(0);
  const shown = useRef(0);
  const sources = useMemo(
    () => (stats?.sampleSources ?? NO_SOURCES).map(({ name, nameEn, kind, heatOnly }): RiverSource => ({ name: locale === "en" ? nameEn ?? name : name, kind, heatOnly })),
    [stats, locale],
  );
  const stages = useMemo(() => stagesOf(stats, locale), [stats, locale]);
  const latest = stats?.latest ?? [];
  // A pulse reaches the paper every second or so; the headline under it changes at most every 2.8s.
  const onArrive = useCallback(() => {
    const now = Date.now();
    if (now - shown.current < 2800 || latest.length < 2) return;
    shown.current = now;
    setAt((i) => (i + 1) % latest.length);
  }, [latest.length]);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 pt-6 lg:pt-3">
      <header className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Kicker>{c.aboutKicker}</Kicker>
          <h1 className="mt-5 text-[34px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[46px] xl:text-[56px] 2xl:text-[64px]">
            {c.aboutHeadline[0]}
            <br />
            <span className="text-accent">{c.aboutHeadline[1]}</span>
          </h1>
          <p className="mt-5 max-w-[36em] text-[15.5px] leading-[1.85] text-ink-3 xl:text-[17px]">
            {c.aboutLead.split("{sources}").map((part, i) => (
              <span key={i}>
                {i > 0 && (stats ? <span className="num font-semibold text-ink">{stats.sources}</span> : c.leadSourcesFallback)}
                {part}
              </span>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <Link to={localeAppPath("/", locale)} reloadDocument prefetch="intent" className={buttonClass("primary", "lg")}>
            {c.ctaSelected} <IconArrowRight size={15} />
          </Link>
          <Link to={localeAppPath("/daily", locale)} prefetch="intent" className={buttonClass("secondary", "lg")}>
            {c.ctaBrief}
          </Link>
        </div>
      </header>
      {/* 信源河带出的标题与信源名：有英文字段就用英文；仍有缺英文的条目时才标注。中文页永不渲染。 */}
      {locale === "en" && stats && (stats.latest.some((i) => !i.titleEn || !i.sourceNameEn) || stats.sampleSources.some((s) => !s.nameEn)) && <MissingEnglishNotice className="mt-1" />}

      <section aria-labelledby="how" className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {c.howHeading}
        </h2>
        <SignalRiver sources={sources} focus={focus} onArrive={onArrive} className="h-[230px] sm:h-[300px] lg:h-[360px] 2xl:h-[420px]">
          <Latest item={latest[at]} className="absolute left-[75%] top-[calc(42%+42px)] hidden w-[25%] px-6 lg:block" />
        </SignalRiver>
        <p className="sr-only">{c.riverAria}</p>
        <Latest item={latest[at]} className="mt-2 border-t border-line pt-4 lg:hidden" />
        <ol className="mt-4 grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
          {stages.map((s, i) => (
            <li
              key={s.no}
              tabIndex={0}
              onPointerEnter={() => setFocus(i)}
              onPointerLeave={() => setFocus(null)}
              onFocus={() => setFocus(i)}
              onBlur={() => setFocus(null)}
              className={`border-line py-6 transition-colors ${STAGE_CELL[i]} ${focus === i ? "bg-accent-softer" : ""}`}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[12px] font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-[17px] font-bold text-ink">{s.title}</h3>
              </div>
              {s.figure && <div className="mt-4">{s.figure}</div>}
              <p className="mt-3 text-[14px] leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-[12px] text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
        {/* 数字这一栏空着会被读成"这个站没有内容"；读不到就说读不到。 */}
        {statsFailed && <p className="mt-3 text-[12.5px] text-ink-4">{c.statsFailed}</p>}
      </section>

      {ABOUT.maker && <Maker maker={ABOUT.maker} />}

      <p className="mt-16 well rounded-card measure px-5 py-4 text-[13px] leading-[1.85] text-ink-3">
        {c.aboutCopyright}
        <Link to={localeAppPath("/feedback", locale)} className="text-accent hover:underline">
          {c.feedbackLink}
        </Link>
        {c.copyrightContactPost}
      </p>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12.5px] text-ink-4">
        <span>{c.footerNote}</span>
        <nav className="flex gap-5" aria-label={c.footerNavAria}>
          <Link to={localeAppPath("/terms", locale)} className="transition-colors hover:text-accent">
            {c.footerTerms}
          </Link>
          <Link to={localeAppPath("/privacy", locale)} className="transition-colors hover:text-accent">
            {c.footerPrivacy}
          </Link>
        </nav>
      </footer>
    </div>
  );
}
