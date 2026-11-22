import { SITE } from "@aihot/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/starred";
import { Presence } from "../components/ui/Presence";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale, type Locale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/starred";
import { ChineseNotice } from "../components/ui/ChineseNotice";
import { exportBundle, importBundle, removeStar, useStarred, type ImportReport } from "../lib/local-state";
import { fullDateTime, shortSourceName } from "../lib/format";
import { publicPath } from "../lib/public-path";
import { IconBookmark, IconDownload, IconClose } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({ title: c.metaTitle, description: c.metaDescription, path: "/starred", noindex: true, locale });
}

/** 导入结果拼成一句话：各段文案在字典里（copy.report），数字是运行时才知道的。 */
function reportText(r: ImportReport, locale: Locale): string {
  const c = copy[locale].report;
  const parts = [c.starredAdded(String(r.starredAdded)), c.readAdded(String(r.readAdded))];
  if (r.starredSkipped || r.readSkipped) parts.push(c.skipped(String(r.starredSkipped + r.readSkipped)));
  if (r.themeApplied) parts.push(c.themeApplied);
  if (r.readFailed) parts.push(c.readFailed);
  return parts.join(copy[locale].reportJoiner);
}


export default function StarredPage() {
  const locale = useLocale();
  const c = copy[locale];
  const starred = useStarred();
  const [mounted, setMounted] = useState(false);
  const [availability, setAvailability] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setMounted(true), []);

  const starredIds = starred.map((s) => s.id).join(",");
  useEffect(() => {
    if (!mounted || !starredIds) return;
    const ids = starredIds.split(",");
    const controller = new AbortController();
    // 收藏上限是 500（`local-state.ts` 的 STAR_LIMIT）。全部拼进一个 `?ids=` 会撞网关的 URL 长度上限：
    // 414 之后旧写法把非 2xx 静默当成 `{}`，收藏页于是显示「什么都没收藏」。按 100 一批取。
    void (async () => {
      const out: Record<string, string> = {};
      for (let i = 0; i < ids.length; i += 100) {
        try {
          const res = await fetch(
            publicPath(`/api/site/items/availability?ids=${encodeURIComponent(ids.slice(i, i + 100).join(","))}`),
            { signal: controller.signal },
          );
          if (!res.ok) continue;
          Object.assign(out, (await res.json()) as Record<string, string>);
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!controller.signal.aborted) setAvailability(out);
    })();
    return () => controller.abort();
  }, [mounted, starredIds]);

  const doExport = () => {
    const blob = new Blob([JSON.stringify(exportBundle(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${SITE.mcpPrefix}-local-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = await importBundle(await file.text());
      setNotice({ kind: report.readFailed ? "error" : "ok", text: c.importDone(reportText(report, locale)) });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : c.importFailed });
    }
  };

  const action = "text-[12.5px] text-ink-3 transition-colors hover:text-accent";
  return (
    <div className="pb-12">
      <header className="flex flex-col gap-2 pb-4 pt-5 sm:flex-row sm:items-start sm:justify-between lg:pt-1">
        <div>
          <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{c.title}</h1>
          <p className="mt-1.5 text-[13px] text-ink-3">{c.lead}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:pt-1.5">
          <button type="button" onClick={() => fileRef.current?.click()} className={action}>
            {c.importFile}
          </button>
          {mounted && starred.length > 0 && (
            <button type="button" onClick={doExport} className={`${action} inline-flex items-center gap-1`}>
              <IconDownload size={13} /> {c.exportLabel}
            </button>
          )}
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => doImport(e.target.files?.[0])} />
        </div>
      </header>
      <p className="rounded-tile border border-line bg-surface px-4 py-2.5 text-[12.5px] text-ink-3">{c.storageNotice}</p>
      {/* 英文页的一行说明：收藏的标题与摘要仍是数据里的中文。中文页渲染为空。 */}
      <ChineseNotice className="mt-1" />
      <Presence show={!!notice} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
        <div
          role="status"
          className={`mt-3 flex items-start justify-between gap-3 rounded-tile px-4 py-2.5 text-[13px] ${notice?.kind === "ok" ? "bg-accent-soft text-accent-ink dark:text-accent" : "bg-hot-soft text-hot"}`}
        >
          {notice?.text}
          <button type="button" aria-label={c.closeAria} onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <IconClose size={14} />
          </button>
        </div>
      </Presence>
      {!mounted ? null : starred.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
          <IconBookmark size={20} className="text-ink-4" />
          <p className="mt-3 text-[13px] text-ink-3">{c.emptyBody}</p>
          <Link to={localeAppPath("/", locale)} reloadDocument className="mt-4 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            {c.emptyCta}
          </Link>
        </div>
      ) : (
        <ul className="mt-3 lg:space-y-3">
          {starred.map((s) => {
            const status = availability[s.id];
            const unavailable = status === "unavailable";
            return (
              <li key={s.id} className={`relative border-b border-line-soft py-4 lg:card lg:px-[18px] lg:py-[15px] ${unavailable ? "opacity-70" : "lg:card-hover"}`}>
                <div className="flex items-center gap-2 text-[12.5px] text-ink-4">
                  <span className="min-w-0 truncate text-ink-3">{shortSourceName(s.sourceName)}</span>
                  {s.publishedAt && <span className="num shrink-0">· {fullDateTime(s.publishedAt)}</span>}
                  <span className="ml-auto hidden shrink-0 sm:inline">
                    {c.savedAtPrefix}<span className="num">{fullDateTime(s.savedAt)}</span>
                  </span>
                  <button type="button" aria-label={c.removeStar} title={c.removeStar} onClick={() => { void removeStar(s.id); }} className="relative z-10 -my-1 ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink sm:ml-0">
                    <IconClose size={14} />
                  </button>
                </div>
                <h2 className="mt-1.5 text-[16px] font-[650] leading-[1.55] text-ink">
                  {unavailable ? (
                    s.title
                  ) : (
                    <Link to={localeAppPath(`/items/${s.id}`, locale)} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent">
                      {s.title}
                    </Link>
                  )}
                </h2>
                {s.summary && <p className="mt-1.5 line-clamp-2 text-[14px] leading-[1.75] text-ink-3">{s.summary}</p>}
                {unavailable && <p className="mt-2 text-[12.5px] text-hot">{c.unavailableNote}</p>}
                {status === "summary-only" && <p className="mt-2 text-[12.5px] text-amber-ink">{c.summaryOnlyNote}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
