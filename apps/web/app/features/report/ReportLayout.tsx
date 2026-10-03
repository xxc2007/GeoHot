import type { ReactNode } from "react";
import type { ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { ReportArchive, ReportPhoneNav } from "./ReportNav";

/**
 * Report pages sit beside their own archive column on a wide screen and under a row of issue chips on a
 * narrow one; which of the two you get is decided here, because together with the padding they set how
 * wide the paper is.
 *
 * The archive column is 280px, and it used to start at the site's desktop breakpoint (961px): at 1024 that
 * left a 484px paper — one column, the phone-size nameplate, no 报眼 calendar. A newspaper should be two
 * columns by the time a laptop opens it, so the rail now starts at xl (1280px), `ReportPhoneNav` runs to
 * xl instead, and this column's padding is 16px until 2xl. The container the paper then gets, with a 15px
 * classic scrollbar counted against the page: 797px at a 1024 window, 773px at 1280, 933px at 1440 — all
 * over the 760px the second column and the desktop masthead need in `ReportPaper`. `now` is the reader's
 * clock, from the loader: it is what tells an issue whose window has not closed yet apart from today's.
 */
export function ReportLayout({ kind, index, current, today, now, children }: { kind: ReportKind; index: ReportNavigationEntry[]; current: string | null; today: string; now?: number; children: ReactNode }) {
  return (
    <div className="report-shell lg:-mx-7 lg:-mb-[72px] lg:-mt-6 lg:flex lg:min-h-dvh">
      <ReportArchive kind={kind} index={index} current={current} />
      <div className="min-w-0 flex-1 pb-6 lg:flex lg:flex-col lg:items-center lg:px-4 2xl:px-10 lg:pb-16 lg:pt-9">
        <ReportPhoneNav kind={kind} index={index} current={current} today={today} now={now} />
        <div className="w-full lg:max-w-[1160px]">{children}</div>
      </div>
    </div>
  );
}
