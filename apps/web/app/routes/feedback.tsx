import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/feedback";
import { Presence } from "../components/ui/Presence";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/feedback";
import { ChineseNotice } from "../components/ui/ChineseNotice";
import { KEYS } from "../lib/local-state";
import { publicPath } from "../lib/public-path";
import { safeBlobSrc } from "../lib/safe-url.ts";
import { IconCheck, IconClose, IconImage, IconUsers } from "../components/icons";
import { buttonClass } from "../components/ui/Controls";
import { RingMark } from "../components/Logo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({ title: c.metaTitle, description: c.metaDescription, path: "/feedback", image: "/og/pages/feedback.png", noindex: true, locale });
}

interface Draft {
  content: string;
  email: string;
  pageUrl: string;
}

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEYS.feedbackDraft);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return typeof d === "object" && d ? { content: String(d.content ?? ""), email: String(d.email ?? ""), pageUrl: String(d.pageUrl ?? "") } : null;
  } catch {
    return null;
  }
}

function writeDraft(d: Draft | null) {
  try {
    if (d === null) localStorage.removeItem(KEYS.feedbackDraft);
    else localStorage.setItem(KEYS.feedbackDraft, JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
  } catch {
    // storage unavailable: the form still works
  }
}

function FeedbackAside() {
  const locale = useLocale();
  const c = copy[locale];
  return (
    <>
      <AsideCard title={c.tipsTitle}>
        <ol className="space-y-2.5">
          {c.tips.map((t, i) => (
            <li key={t} className="flex gap-2.5 text-[13px] leading-[1.6] text-ink-3">
              <span className="mono mt-px text-[11px] font-bold text-accent">{String(i + 1).padStart(2, "0")}</span>
              {t}
            </li>
          ))}
        </ol>
      </AsideCard>
      <AsideCard title={c.sourcesTitle}>
        <p className="text-[13px] leading-[1.75] text-ink-3">{c.sourcesBody}</p>
      </AsideCard>
    </>
  );
}

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TEXT = 2000;

export default function FeedbackPage() {
  const locale = useLocale();
  const c = copy[locale];
  const [params] = useSearchParams();
  const [draft, setDraft] = useState<Draft>({ content: "", email: "", pageUrl: params.get("from") ?? "" });
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "sending" | "done" | "error"; message?: string; id?: number }>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 预览地址交给 <img src> 前先过 scheme 白名单（只认本页 createObjectURL 的 blob:，见 lib/safe-url.ts）。
  // 值虽然只来自上面那次 createObjectURL，但这一层不假设上游——也是 CodeQL js/xss-through-dom 的出口。
  const shotSrc = safeBlobSrc(shot?.url);

  useEffect(() => {
    const saved = readDraft();
    if (saved) setDraft((d) => ({ ...saved, pageUrl: d.pageUrl || saved.pageUrl }));
    else if (!params.get("from") && document.referrer.startsWith(location.origin)) setDraft((d) => ({ ...d, pageUrl: document.referrer }));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => writeDraft(draft.content || draft.email ? draft : null), 400);
    return () => clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    if (!shot) return;
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  const pick = (file: File | null | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setState({ kind: "error", message: c.shotTypeError });
    if (file.size > MAX_IMAGE) return setState({ kind: "error", message: c.shotSizeError });
    setShot({ file, url: URL.createObjectURL(file) });
    setState({ kind: "idle" });
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) pick(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.content.trim().length < 2) return setState({ kind: "error", message: c.emptyContentError });
    setState({ kind: "sending" });
    try {
      const form = new FormData();
      form.set("content", draft.content);
      form.set("email", draft.email);
      form.set("pageUrl", draft.pageUrl);
      if (shot) form.set("screenshot", shot.file);
      const res = await fetch(publicPath("/api/site/feedback"), { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      // body.detail 是接口的报错文案，保持原样不算漏翻；缺省兜底才走字典。
      if (!res.ok) return setState({ kind: "error", message: body.detail ?? c.sendFailed });
      writeDraft(null);
      setState({ kind: "done", id: body.id });
      setDraft({ content: "", email: "", pageUrl: "" });
      setShot(null);
    } catch {
      setState({ kind: "error", message: c.networkFailed });
    }
  };

  if (state.kind === "done") {
    // 成功页脱离阅读栏：整块可用视口内水平垂直居中，内容直接坐在页面背景上（2026-10-31 站长要求
    // 与大背景融为一体，不做浮起的卡片）。状态恒为「已收到」：刚提交的反馈只可能是这个状态。
    return (
      <div className="flex min-h-[calc(100dvh-9rem)] w-full flex-col items-center justify-center px-4 py-10 text-center">
        <div className="anim-pop-in flex size-16 items-center justify-center rounded-full bg-accent text-accent-contrast">
          <IconCheck size={30} />
        </div>
        <h1 className="mt-7 text-[24px] font-semibold text-ink">{c.doneTitle}</h1>
        <p className="mt-2 text-[14px] text-ink-3">
          {c.doneBodyPre}
          <span className="mono font-semibold text-ink">#{state.id}</span>
          {c.doneBodyPost}
        </p>
        <p className="mt-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bg-sunk px-3 py-1 text-[12.5px] text-ink-3 ring-1 ring-line-soft">
            <span className="size-1.5 rounded-full bg-accent" />
            {c.doneStatus}
          </span>
        </p>
        <p className="mt-3 text-[13px] text-ink-4">{c.doneHint}</p>
        <Link to="/" reloadDocument className="mt-8 inline-flex h-10 items-center rounded-full bg-ink px-6 text-[14px] font-medium text-bg transition-opacity hover:opacity-90">
          {c.backHome}
        </Link>
      </div>
    );
  }

  const field = "w-full rounded-card bg-bg-sunk text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent dark:bg-bg-muted/60 dark:focus:bg-surface";
  const label = "mb-2 block text-[13px] font-semibold text-ink";
  const canSend = draft.content.trim().length >= 2 && state.kind !== "sending";
  return (
    <ReadingLayout aside={<FeedbackAside />}>
      <header>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{c.headline}</h1>
          <Link to="/admin/feedback" className={`${buttonClass("secondary", "md")} shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}>
            <IconUsers size={16} className="text-accent" />
            {c.manageFeedback}
          </Link>
        </div>
        <p className="mt-2 text-[14.5px] leading-relaxed text-ink-3">{c.lead}</p>
      </header>

      <form
        onSubmit={submit}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={`card mt-6 overflow-hidden transition-shadow ${dragging ? "shadow-[0_0_0_3px_var(--accent-soft)] ring-1 ring-accent" : ""}`}
      >
        <div className="space-y-5 p-5 sm:p-6">
          <div>
            <label htmlFor="fb-content" className={label}>
              {c.contentLabel}
            </label>
            <div className="relative">
              <textarea
                id="fb-content"
                required
                rows={6}
                maxLength={MAX_TEXT}
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                placeholder={c.contentPlaceholder}
                className={`${field} block resize-y px-4 pb-8 pt-3.5 text-[14.5px] leading-relaxed`}
              />
              <span className="mono pointer-events-none absolute bottom-3 right-4 text-[11px] text-ink-4">
                {draft.content.length} / {MAX_TEXT}
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="fb-email" className={label}>
              {c.emailLabel} <span className="font-normal text-ink-4">{c.optional}</span>
            </label>
            <input id="fb-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder={c.emailPlaceholder} className={`${field} h-11 px-4 text-[14.5px]`} />
          </div>

          <div>
            <span className={label}>
              {c.shotLabel} <span className="font-normal text-ink-4">{c.optional}</span>
            </span>
            {shot ? (
              <div className="flex items-center gap-4 well rounded-card p-3">
                {shotSrc && <img src={shotSrc} alt={c.shotPreviewAlt} className="h-16 w-24 shrink-0 rounded-control border border-line bg-surface object-cover" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink-2">{shot.file.name}</div>
                  <div className="mono mt-0.5 text-[11.5px] text-ink-4">{(shot.file.size / 1024 / 1024).toFixed(2)} MB</div>
                </div>
                <button type="button" aria-label={c.removeShot} onClick={() => setShot(null)} className="grid size-8 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-surface hover:text-ink">
                  <IconClose size={15} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={`group flex w-full items-center gap-3.5 rounded-card border border-dashed px-4 py-3.5 text-left transition-colors ${dragging ? "border-accent bg-accent-softer" : "border-line-strong hover:border-ink-4 hover:bg-bg-sunk/60"}`}
              >
                <span className="grid size-10 shrink-0 place-items-center well rounded-tile text-ink-3 transition-colors group-hover:text-accent">
                  <IconImage size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-ink-2">{c.shotButton}</span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-4">{c.shotHint}</span>
                </span>
              </button>
            )}
            {/* The visible button is the control; this input is how it opens the OS picker. Leaving it in
                the tab order gave an unnamed 1×1 control a focus stop of its own. */}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => pick(e.target.files?.[0])} />
          </div>

          <Presence show={state.kind === "error"} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
            <p role="alert" className="rounded-tile bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">
              {state.kind === "error" ? state.message : ""}
            </p>
          </Presence>
        </div>

        <div className="flex flex-col-reverse gap-4 border-t border-line-soft bg-bg-sunk/50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:bg-bg-muted/30">
          <p className="text-[12px] leading-relaxed text-ink-4 sm:max-w-[400px]">
            {c.privacyPre}
            <Link to={localeAppPath("/privacy", locale)} className="text-accent hover:underline">
              {c.privacyLink}
            </Link>
            {c.privacyPost}
          </p>
          <button
            type="submit"
            disabled={!canSend}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 self-start rounded-full bg-accent px-6 text-[14px] font-medium text-accent-contrast transition-[background-color,opacity] hover:bg-accent-ink disabled:bg-line-strong disabled:text-ink-4 sm:self-auto"
          >
            {state.kind === "sending" && <RingMark className="size-4" spinning />}
            {c.send}
          </button>
        </div>
      </form>
      <StatusLookup field={field} />
    </ReadingLayout>
  );
}

/** 状态词的键是接口返回的中文枚举值（展示时原样输出，不算漏翻），这里只用来决定配色。 */
const STATUS_ZH: Record<string, string> = { 已收到: "ok", 处理中: "warn", 已回复: "ok", 已解决: "ok" };

/** 折叠的「查询处理状态」卡：编号 + 提交时留的邮箱 → 一个状态词。接口对查不到的回答是同一个
 *  通用空态（不区分编号不存在与邮箱不匹配），因此页面也只给一种提示，不给探测留缝。 */
function StatusLookup({ field }: { field: string }) {
  const c = copy[useLocale()];
  const [open, setOpen] = useState(true);
  const [id, setId] = useState("");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<{ kind: "status" | "missing" | "error"; status?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = Number(id);
    if (!Number.isInteger(num) || num <= 0) return setResult({ kind: "error" });
    setBusy(true);
    setResult(null);
    try {
      const qs = new URLSearchParams({ id: String(num) });
      if (email.trim()) qs.set("email", email.trim());
      const res = await fetch(publicPath(`/api/site/feedback-status?${qs}`));
      const body = (await res.json().catch(() => ({}))) as { status?: string | null };
      if (res.status === 429) setResult({ kind: "error" });
      else setResult(body.status ? { kind: "status", status: body.status } : { kind: "missing" });
    } catch {
      setResult({ kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mt-6 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-4 text-left sm:px-6"
      >
        <span>
          <span className="block text-[14.5px] font-semibold text-ink">{c.lookupTitle}</span>
          <span className="mt-0.5 block text-[12.5px] text-ink-4">{c.lookupHint}</span>
        </span>
        <span aria-hidden className={`text-ink-4 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <form onSubmit={lookup} className="space-y-4 border-t border-line-soft px-5 pb-5 pt-4 sm:px-6">
          {/* 本页唯一的数据库动态内容是查询结果里的状态词（接口返回中文，保持原样）：英文页在这段
              动态内容之前放一行说明。中文页渲染为空。 */}
          <ChineseNotice />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="fb-lookup-id" className="mb-2 block text-[13px] font-semibold text-ink">{c.lookupIdLabel}</label>
              <input id="fb-lookup-id" inputMode="numeric" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ""))} placeholder={c.lookupIdPlaceholder} className={`${field} h-11 px-4 text-[14.5px]`} />
            </div>
            <div>
              <label htmlFor="fb-lookup-email" className="mb-2 block text-[13px] font-semibold text-ink">
                {c.emailLabel} <span className="font-normal text-ink-4">{c.lookupEmailNote}</span>
              </label>
              <input id="fb-lookup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="reader@example.com" className={`${field} h-11 px-4 text-[14.5px]`} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !id.trim()}
              className="inline-flex h-10 items-center justify-center rounded-full bg-ink px-5 text-[13.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:bg-line-strong disabled:text-ink-4"
            >
              {busy && <RingMark className="size-4" spinning />}
              {c.lookupSubmit}
            </button>
            {result?.kind === "status" && (
              <span className={`inline-flex items-center gap-1.5 rounded-full bg-bg-sunk px-3 py-1 text-[13px] ring-1 ring-line-soft ${STATUS_ZH[result.status ?? ""] === "warn" ? "text-ink" : "text-ink-2"}`}>
                <span className={`size-1.5 rounded-full ${STATUS_ZH[result.status ?? ""] === "warn" ? "bg-hot" : "bg-accent"}`} />
                {c.statusPrefix}
                {result.status}
              </span>
            )}
          </div>
          <Presence show={result?.kind === "missing"} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
            <p role="status" className="rounded-tile bg-bg-sunk px-3.5 py-2.5 text-[13px] text-ink-3">
              {c.lookupMissing}
            </p>
          </Presence>
          <Presence show={result?.kind === "error"} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
            <p role="alert" className="rounded-tile bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">
              {busy ? "" : c.lookupError}
            </p>
          </Presence>
        </form>
      )}
    </section>
  );
}
