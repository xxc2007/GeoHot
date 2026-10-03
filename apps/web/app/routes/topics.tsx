import { Link, useLoaderData } from "react-router";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  // 接口的 5xx 走 loadOr404 的约定（503 + 不缓存），别让一次读不到变成页面 500。
  return loadOr404<{ topics: TopicSummary[] }>("/api/site/topics", { signal: request.signal });
}

export function meta() {
  // 数不写死：主题随行业包增减，页面上那句「共 N 个方向」由数据自己数（这句曾写死 45，加一个主题就过期）。
  return pageMeta({ title: "主题", description: "按区域与机构、自然与人文领域、内容与题材聚合的地理主题页：青藏高原、环太平洋火山地震带、东部沿海城市群，中国地震台网、USGS、中国气象局、NOAA、NASA、哥白尼计划等发布主体。", path: "/topics", image: "/og/pages/topics.png" });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const GROUPS = [
  { key: "company", name: "区域与机构", blurb: "按地区与观测发布主体追踪：地球哪一片、由谁在测和在说" },
  { key: "field", name: "自然与人文领域", blurb: "按地理领域深挖：灾害与气候、水系与地貌、城市与产业、地理信息技术与野外考察……" },
  { key: "genre", name: "内容与题材", blurb: "按内容形态浏览：灾害速报、观测数据、区划政策、研究发现、考察记录与影像图集……" },
] as const;

export default function TopicsPage() {
  const { topics } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">按主题看地理</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          按区域与机构、自然与人文领域、内容与题材浏览 <span className="num">{topics.length}</span> 个主题，持续汇集近期焦点与精选。
        </p>
      </header>
      {GROUPS.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      查看 {t.total} 条精选 <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
