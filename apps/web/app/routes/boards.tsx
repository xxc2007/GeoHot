import { SITE } from "@aihot/industry/site";
import { Link, useLoaderData } from "react-router";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { PlateMark, type PlateKind } from "../features/board/PlateMark";

interface BoardSummary {
  slug: string;
  name: string;
  plate: PlateKind;
  description: string;
  counts: { curated: number; index: number };
}

export async function loader({ request }: { request: Request }) {
  return loadOr404<{ boards: BoardSummary[] }>("/api/site/boards", { signal: request.signal });
}

export function meta() {
  return pageMeta({
    title: "板块",
    description: "跨类别板块页：每个板块分「本站精选」（人工判断）与「来源原文」（各信源已公开、尚未经本站编辑判断的条目）两条线。",
    path: "/boards",
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "板块", path: "/boards" }]),
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export default function BoardsPage() {
  const { boards } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">按板块看地理</h1>
        <p className="measure mt-1.5 text-[13px] leading-relaxed text-ink-3">
          <span className="num">{boards.length}</span> 个跨类别方向，每个板块两条：<span className="text-ink-2">本站精选</span>是编辑判断，
          <span className="text-ink-2">来源原文</span>是各信源当天已公开的条目——标题与链接指向出处，本站未对它作编辑判断。
        </p>
      </header>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {boards.map((b) => (
          <li key={b.slug}>
            <Link to={`/boards/${b.slug}`} prefetch="intent" aria-label={`进入${b.name}板块`} className="card card-hover group flex h-full flex-col px-5 py-[18px]">
              <span className="flex items-center gap-2.5 text-ink-3">
                <PlateMark plate={b.plate} className="h-6 w-6" />
                <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{b.name}</span>
              </span>
              <span className="mt-2 line-clamp-3 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{b.description}</span>
              <span className="mono mt-3 flex flex-wrap gap-x-3 text-[11.5px] text-accent">
                <span>
                  精选 {b.counts.curated} <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                </span>
                <span className="text-ink-4">来源原文 {b.counts.index}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="measure mt-6 text-[12.5px] leading-relaxed text-ink-4">
        主题页按区域、机构与领域串联同一件事的来龙去脉；板块页按学科与用途把当天的条目归到一处。两者都只读同一套公开门槛。
      </p>
    </div>
  );
}
