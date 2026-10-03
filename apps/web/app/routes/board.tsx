import { SITE } from "@aihot/industry/site";
import { Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/board";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { DayList, Pagination } from "../features/feed/DayList";
import { FeedItem } from "../features/feed/FeedItem";
import { EmptyState, MoreLink } from "../components/ui/Page";
import { PlateMark, type PlateKind } from "../features/board/PlateMark";

interface BoardPageData {
  board: { slug: string; name: string; plate: PlateKind; description: string; categories: string[] };
  counts: { curated: number; index: number };
  curated: { items: FeedItemSummary[]; collapsed: Array<{ sourceId: string; sourceName: string; count: number }> };
  index: { items: FeedItemSummary[]; collapsed: Array<{ sourceId: string; sourceName: string; count: number }> };
  page: number;
  pageCount: number;
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60" };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const page = params.page ? Number(params.page) : 1;
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw new Response("Not found", { status: 404 });
  if (params.page === "1") throw redirect(`/boards/${params.slug}`, 308);
  const data = await loadOr404<BoardPageData>(`/api/site/boards/${encodeURIComponent(params.slug)}?page=${page}`, { signal: request.signal });
  return { data };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("板块不存在") }, { name: "robots", content: "noindex" }];
  const { board, page } = loaderData.data;
  const path = page > 1 ? `/boards/${board.slug}/page/${page}` : `/boards/${board.slug}`;
  return pageMeta({
    title: page > 1 ? `${board.name} · 第 ${page} 页` : board.name,
    description: board.description,
    path,
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "板块", path: "/boards" }, { name: board.name, path: `/boards/${board.slug}` }]),
  });
}

export default function BoardPage() {
  const { data } = useLoaderData<typeof loader>();
  const { board, counts, curated, index, page, pageCount } = data;
  const href = (p: number) => (p <= 1 ? `/boards/${board.slug}` : `/boards/${board.slug}/page/${p}`);
  return (
    <div className="pb-6">
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-ink-3">
              <PlateMark plate={board.plate} />
            </span>
            <div>
              <h1 className="text-[22px] font-bold leading-[1.35] text-ink">{board.name}</h1>
              <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-3">{board.description}</p>
            </div>
          </div>
          <span className="hidden pt-2 lg:block">
            <MoreLink to="/boards">全部板块</MoreLink>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px] text-ink-4">
          <span>
            <span className="num mr-1 text-[20px] font-bold text-ink">{counts.curated.toLocaleString("zh-CN")}</span>条精选
          </span>
          <span>
            <span className="num mr-1 text-[20px] font-bold text-ink">{counts.index.toLocaleString("zh-CN")}</span>条来源原文
          </span>
        </div>
      </header>

      <section aria-labelledby="board-curated">
        <div className="mb-1 mt-2 flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 id="board-curated" className="text-[18px] font-bold text-ink">
            本站精选
          </h2>
          <span className="hidden text-[12px] text-ink-4 sm:inline">编辑判断与署名语料，同其它板块</span>
        </div>
        {curated.items.length === 0 ? (
          <div className="lg:card">
            <EmptyState as="h2" title="这个板块还没有入选的精选" action={<Link to="/all" className="text-[13px] font-medium text-accent hover:underline">去全部动态里找找</Link>}>
              精选来自人工签署的编辑判断；这个板块的精选会随新语料一起出现。
            </EmptyState>
          </div>
        ) : (
          <DayList items={curated.items} />
        )}
      </section>

      <section aria-labelledby="board-index" className="pt-9">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h2 id="board-index" className="text-[18px] font-bold text-ink">
            来源原文
          </h2>
          <span className="text-[12px] text-ink-4">来源原文 · 本站未作编辑判断，标题与链接指向出处</span>
        </div>
        {index.items.length === 0 ? (
          <div className="lg:card">
            <EmptyState as="h2" title="这个板块暂时没有可列出的来源原文">
              来源原文按类别汇集各信源当天已公开的条目；换一批信源或换个板块看看。
            </EmptyState>
          </div>
        ) : (
          <>
            {index.items.map((item) => (
              <FeedItem key={item.id} item={item} showTags />
            ))}
            {index.collapsed.map((c) => (
              <p key={c.sourceId} className="mt-2 text-[12.5px] leading-relaxed text-ink-4">
                ＋{c.count} 条来自同一来源 <span className="text-ink-3">{c.sourceName}</span>
              </p>
            ))}
          </>
        )}
      </section>
      <Pagination page={page} pageCount={pageCount} href={href} />
    </div>
  );
}
