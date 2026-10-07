import { Link } from "react-router";
import type { HotStripEntry } from "@aihot/contracts/site";
import { withSubject } from "@aihot/industry/site";
import { IconArrowRight, IconMinus, IconTrendDown, IconTrendUp } from "../../components/icons";
import { monthDayTime } from "../../lib/format";
import { Faces } from "../hot/Faces";

// As on the original list: the top three in the ranking colours at the heaviest weight.
// Sizes come off the type scale (--text-lead 15px for the podium ranks, --text-body 14px for the rest);
// the colours are the rank tokens, whose light set was darkened this round to hold AA on the hover row.
const RANK_COLOR = ["text-lead font-black text-rank-1", "text-lead font-black text-rank-2", "text-lead font-black text-rank-3"];

function hrefOf(e: HotStripEntry): string {
  return e.storyPublicId ? `/story/${e.storyPublicId}` : e.itemId ? `/items/${e.itemId}` : "/hot";
}

/** Where the heat is heading, as a small arrow (a "新" mark for a story new to the ranking). */
function TrendMark({ trend }: { trend: HotStripEntry["trend"] }) {
  // The arrow is the only carrier of this, so it has to be named. `Svg` gives an icon that carries an
  // `aria-label` a `role="img"` (a bare <svg> with only a label is dropped by some screen readers); the
  // label was already being written here, and thrown away by the old hardcoded `aria-hidden` (WCAG 1.1.1).
  if (trend === "up") return <IconTrendUp size={14} strokeWidth={2.2} className="text-hot" aria-label="热度上升" />;
  if (trend === "down") return <IconTrendDown size={14} strokeWidth={2.2} className="text-ink-4" aria-label="热度回落" />;
  if (trend === "new") return <span className="rounded-full bg-accent-soft px-1.5 text-[10.5px] font-semibold leading-4 text-accent">新</span>;
  if (trend === "unknown") return null; // sources behind on collection: no comparison to show
  return <IconMinus size={14} strokeWidth={2.2} className="text-ink-4" aria-label="热度持平" />;
}

/** The board is recomputed every five minutes; one this old means every recompute since it came out empty. */
const STALE_AFTER_MS = 2 * 3600_000;

/**
 * The top of the hot ranking on the home page, kept quiet: a live dot, coloured ranks and titles, then
 * columns of fixed width so every row lines up — who is talking (精选组 faces, from sm), "N 热度" and an arrow for
 * where it is heading. The whole row lights up on hover.
 *
 * The block is always there when a ranking exists. An empty ranking shows one honest line instead of
 * vanishing: the strip used to disappear entirely, so on a site whose heat bar is 「两家以上独立信源同时
 * 讨论」 the reader could never tell the difference between "nothing is hot" and "this page has no such
 * feature" — and the block was invisible for weeks for the second reason (the merge step was off).
 *
 * `asOf` is the cut-off hour of the board being shown. The read layer keeps the newest board that has
 * events in it for up to a day (an empty hourly recompute no longer blanks the page), so the pulsing dot —
 * which claims "recomputed right now" — is only allowed while the board is from this hour; after that the
 * block says 截至 X 时 and stops pulsing. Both timestamps come from the response body, never from the
 * browser clock, so the server render and the hydration agree.
 */
export function HotTopics({ entries, asOf, generatedAt }: { entries: HotStripEntry[]; asOf: string | null; generatedAt: string }) {
  const stale = entries.length > 0 && (asOf === null || Date.parse(asOf) < Date.parse(generatedAt) - STALE_AFTER_MS);
  return (
    <section
      aria-labelledby="hot-topics"
      className="card relative mb-6 overflow-hidden bg-[radial-gradient(120%_90%_at_100%_0%,var(--hot-soft),transparent_55%)] px-4 pb-2 pt-3.5 lg:px-5"
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 id="hot-topics" className="flex items-center gap-2 text-body font-semibold text-ink">
          <span className="relative flex size-2" aria-hidden="true">
            {!stale && <span className="absolute inline-flex size-full animate-ping rounded-full bg-hot opacity-40" />}
            <span className={`relative inline-flex size-2 rounded-full ${stale ? "bg-ink-4" : "bg-hot"}`} />
          </span>
          当前热点
          {stale && asOf && <span className="num text-meta font-normal text-ink-4">截至 {monthDayTime(asOf)}</span>}
        </h2>
        <Link to="/hot" className="group inline-flex items-center gap-1 text-meta text-ink-3 transition-colors hover:text-accent">
          完整榜单 <IconArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-2 py-2 text-body text-ink-3">
          <span>过去 48 小时还没有两家以上信源同时讨论的事件。</span>
          <Link to="/all" className="text-hot-ink hover:underline">看今天的全部{withSubject("动态")} →</Link>
        </p>
      ) : (
      <ol>
        {entries.slice(0, 5).map((e, i) => (
          <li key={e.rank}>
            <Link
              to={hrefOf(e)}
              className="group -mx-2 grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-tile px-2 py-2 transition-colors hover:bg-bg-sunk/70 sm:grid-cols-[20px_minmax(0,1fr)_120px_64px_20px] sm:gap-x-4 dark:hover:bg-bg-muted/40"
            >
              <span className={`num text-center leading-none ${RANK_COLOR[i] ?? "text-body font-bold text-rank-rest"}`}>{e.rank}</span>
              <span className="line-clamp-2 min-w-0 text-body font-semibold leading-[1.5] text-ink transition-colors group-hover:text-accent lg:line-clamp-1">{e.title}</span>
              <span className="hidden justify-end sm:flex">
                <Faces interactive={false} participants={e.participants} total={e.participantCount} size={22} max={3} />
              </span>
              <span className="flex items-center justify-end gap-2.5 sm:contents">
                <span className="whitespace-nowrap text-right text-meta text-ink-4" title="热度指数">
                  <span className="num text-[13.5px] font-semibold text-ink-2">{Math.round(e.heat)}</span> 热度
                </span>
                <span className="flex w-5 justify-center">
                  <TrendMark trend={e.trend} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
      )}
    </section>
  );
}
