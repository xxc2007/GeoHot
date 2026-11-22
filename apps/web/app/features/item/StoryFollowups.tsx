import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { StoryFollowup, StoryFollowupsResponse, StoryRef } from "@aihot/contracts/site";
import { MoreLink } from "../../components/ui/Page";
import { relativeTime, shortSourceName } from "../../lib/format";
import { localeAppPath, useLocale } from "../../lib/i18n";
import { copy } from "../../lib/i18n/item-ui";
import { publicPath } from "../../lib/public-path";

/**
 * "事件后续": the other developments of the event this report belongs to, newest first, with a link to
 * the whole event. Loaded after the page so the article renders without waiting for it.
 */
export function StoryFollowups({ story, currentId }: { story: StoryRef; currentId: string }) {
  const locale = useLocale();
  const t = copy[locale].followups;
  const [items, setItems] = useState<StoryFollowup[] | null>(null);
  const [more, setMore] = useState(false);
  // A fetch that failed used to be indistinguishable from one that found nothing: `items` stayed null
  // and the block rendered no markup at all. `failed` is set by the same request that sets `items`, and
  // retrying re-runs it (the same 点此重试 the feed's expansions give).
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    setItems(null);
    setFailed(false);
    const load = () => {
      if (started) return;
      started = true;
      fetch(publicPath(`/api/site/stories/${encodeURIComponent(story.publicId)}/followups`), { signal: controller.signal })
        .then((r) => {
          // 404 = 这条事件不存在（比如已被并走）——不是"暂时加载不了"：给读者一个永远点不通的重试按钮
          // 比什么都不显示更糟（线上 2026-10-03 的条目页就是这样）。真正会恢复的失败（5xx、断网）
          // 才留重试。
          if (r.status === 404) return { items: [], more: false } satisfies StoryFollowupsResponse;
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<StoryFollowupsResponse>;
        })
        .then((body: StoryFollowupsResponse) => {
          if (controller.signal.aborted) return;
          setItems(body.items.filter((d) => d.representative.id !== currentId));
          setMore(body.more);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: "500px" });
    if (observer && anchor.current) observer.observe(anchor.current);
    else load();
    return () => { observer?.disconnect(); controller.abort(); };
  }, [story.publicId, currentId, attempt]);
  return <div ref={anchor}>
    <noscript><a href={publicPath(localeAppPath(`/story/${story.publicId}`, locale))}>{t.noscript}</a></noscript>
    {items && items.length > 0 && <Followups items={items} more={more} story={story} />}
    {failed && (
      <p className="mt-3 text-ui" aria-live="polite">
        <button type="button" onClick={() => setAttempt((a) => a + 1)} className="text-hot-ink hover:underline">
          {t.failed}
        </button>
      </p>
    )}
  </div>;
}

function Followups({items, more, story}: {items: StoryFollowup[]; more: boolean; story: StoryRef}) {
  const locale = useLocale();
  const t = copy[locale].followups;
  return (
    <section className="mt-10 border-t border-line pt-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-body font-semibold text-ink">
          {t.heading} <span className="num font-normal text-ink-4">· {items.length}{more ? "+" : ""}</span>
        </h2>
        <MoreLink to={localeAppPath(`/story/${story.publicId}`, locale)}>{t.viewAll}</MoreLink>
      </div>
      <ul className="divide-y divide-line-soft">
        {items.map((d) => (
          <li key={d.factId}>
            <Link to={localeAppPath(`/items/${d.representative.id}`, locale)} className="group flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 rounded-mark bg-accent-soft px-1 text-[10.5px] leading-[16px] text-accent">{t.sameEvent}</span>
                <span className="min-w-0 text-[13.5px] leading-snug text-ink-2 group-hover:text-accent sm:truncate">{d.representative.title}</span>
              </span>
              <span className="shrink-0 pl-[46px] text-[12px] text-ink-4 sm:pl-0" suppressHydrationWarning>
                {shortSourceName(d.representative.source.name)} · {relativeTime(d.representative.timelineAt, locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
