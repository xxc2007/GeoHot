import { SITE } from "@aihot/industry/site";
import { Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/topic";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { loadOr404, withLang } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/topic";
import { Pagination } from "../features/feed/DayList";
import { InfiniteTopicList } from "../features/topics/InfiniteTopicList";
import { todayOf } from "../lib/format";
import { EmptyState, MoreLink } from "../components/ui/Page";
import { useLivePublicData } from "../lib/use-live-public-data";

/** Selected items of a topic: shared caches keep the page as long as its api answer (one minute). */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60" };
}

interface TopicPageData {
  topic: {
    slug: string;
    name: string;
    nameEn?: string | null;
    group: string;
    definition: string;
    definitionEn?: string | null;
    total: number;
    indexable: boolean;
    related: Array<{ slug: string; name: string; nameEn?: string | null }>;
  };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  generatedAt: string;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const page = params.page ? Number(params.page) : 1;
  const locale = localeFromPath(new URL(request.url).pathname);
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw new Response("Not found", { status: 404 });
  // Page 1 lives at the topic's own address (308)；英文页的跳转也留在 /en，不能把读者送回中文壳。
  if (params.page === "1") throw redirect(locale === "en" ? `/en/topics/${params.slug}` : `/topics/${params.slug}`, 308);
  const data = await loadOr404<TopicPageData>(withLang(`/api/site/topics/${encodeURIComponent(params.slug)}?page=${page}`, locale), { signal: request.signal });
  return { data };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  if (!loaderData) return [{ title: titled(c.notFoundTitle) }, { name: "robots", content: "noindex" }];
  const { topic, page } = loaderData.data;
  const path = page > 1 ? `/topics/${topic.slug}/page/${page}` : `/topics/${topic.slug}`;
  return pageMeta({
    title: page > 1 ? `${topic.name}${c.metaPageSuffix(String(page))}` : topic.name,
    description: topic.definition,
    path,
    image: `/og/topics/${topic.slug}.png`,
    noindex: !topic.indexable,
    locale,
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: c.breadcrumbTopics, path: "/topics" }, { name: topic.name, path: `/topics/${topic.slug}` }]),
  });
}

export default function TopicPage() {
  const { data: initial } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const data = useLivePublicData(initial, initial.page === 1 ? `/api/site/topics/${encodeURIComponent(initial.topic.slug)}?page=1${locale === "en" ? "&lang=en" : ""}` : null);
  const { topic, items, page, pageCount } = data;
  const href = (p: number) => (p <= 1 ? localeAppPath(`/topics/${topic.slug}`, locale) : localeAppPath(`/topics/${topic.slug}/page/${p}`, locale));
  const first = (page - 1) * 20 + 1;
  const last = first + items.length - 1;
  return (
    <div className="pb-6">
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-[22px] font-bold leading-[1.35] text-ink">{topic.name}</h1>
          <span className="hidden pt-2 lg:block">
            <MoreLink to={localeAppPath("/topics", locale)}>{c.allTopics}</MoreLink>
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-3">{topic.definition}</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-[12.5px] text-ink-4">
            <span className="num mr-1 text-[20px] font-bold text-ink">{topic.total.toLocaleString(locale === "en" ? "en-US" : "zh-CN")}</span>{c.selectedUnit}
          </span>
          {topic.related.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="text-ink-4">{c.relatedLabel}</span>
              {topic.related.map((r) => (
                <Link key={r.slug} to={localeAppPath(`/topics/${r.slug}`, locale)} className="chip">
                  {r.name}
                </Link>
              ))}
            </span>
          )}
        </div>
      </header>
      {/* 主题名/定义或条目真有回退中文时才标注；有英文字段就不该自称中文。 */}
      {locale === "en" && (!topic.nameEn || !topic.definitionEn || items.some((item) => item.textLocale !== "en")) && <p className={`text-[12.5px] text-ink-4 mt-1`}>{c.chineseNotice}</p>}

      <div className="mb-1 mt-2 flex items-baseline justify-between">
        <h2 className="text-[18px] font-bold text-ink">{c.latestHeading}</h2>
        {items.length > 0 && (
          <span className="num text-[12px] text-ink-4">
            {c.rangePre}{first}–{last}{c.rangeMid}{topic.total.toLocaleString(locale === "en" ? "en-US" : "zh-CN")}{c.rangePost}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="lg:card">
          {/* 分页越界时不能说「这个主题暂时还没有精选内容」——它明明有，只是不在这一页。
             （读取层对越界页回 404，所以这条分支是 defence in depth：数据一旦给出空白页，页面自己认账。） */}
          {page > 1 ? (
            <EmptyState
              as="h2"
              title={c.emptyPageTitle(String(page))}
              action={<Link to={localeAppPath(`/topics/${topic.slug}`, locale)} className="text-[13px] font-medium text-accent hover:underline">{c.emptyPageAction}</Link>}
            >
              {c.emptyPageBody(topic.total.toLocaleString("zh-CN"), String(pageCount))}
            </EmptyState>
          ) : (
            // 空手而归要给出路：这一页的「精选」是全部存量，没有时间窗口（读取层就是这样查的），
            // 所以不能说「最近 30 天」——那句话在页面上与同一屏的「0 条精选」互相打脸（10-03 复核 /topics/ipcc）。
            <EmptyState
              as="h2"
              title={c.emptyTitle}
              action={<Link to={localeAppPath("/all", locale)} className="text-[13px] font-medium text-accent hover:underline">{c.emptyAction}</Link>}
            >
              {c.emptyBody}
            </EmptyState>
          )}
        </div>
      ) : (
        // 2026-11-14：站长要求「所有需要按一下下一页的设计都换成一直下拉」，主题页也换成触底续读。
        // 分页链接留在 <noscript> 里，爬虫与没有 JS 的读者仍能翻页。
        <InfiniteTopicList
          slug={topic.slug}
          initialItems={items}
          initialPage={page}
          pageCount={pageCount}
          today={todayOf(data.generatedAt)}
        />
      )}
      <noscript>
        <Pagination page={page} pageCount={pageCount} href={href} />
      </noscript>
    </div>
  );
}
