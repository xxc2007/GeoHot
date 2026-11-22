// Language switch, the capsule + dropdown pattern from the reference site (nc15) rebuilt with this
// repo's tokens. The button carries a linear globe, the current language's own name and a caret that
// turns over when the menu opens; the menu links to the same page in the other language. The whole
// block is `notranslate` / `translate="no"` (and so are the language-name spans inside): bilingual
// browser plugins ignore the container but still expand text nodes — nc15 measured them widening
// 「简体中文」 into 「English 英语」 until the capsule burst, so the names never travel bare.
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { localeAppPath, useLocale, type Locale } from "../../lib/i18n";
import { copy as chrome } from "../../lib/i18n/shell";
import { IconCheck, IconChevronDown, IconGlobe } from "../icons";

/** The two languages the site publishes, each named in its own script (never translated). */
const LANGUAGES: Array<{ key: Locale; name: string; lang: string }> = [
  { key: "zh", name: "简体中文", lang: "zh-Hans" },
  { key: "en", name: "English", lang: "en" },
];

/** Fixed menu width: right alignment needs a number, and both names fit comfortably in it. */
const MENU_W = 172;
/** Generous height estimate of the two-item menu, for the flip-up decision before it is rendered. */
const MENU_H = 104;

export function LangSwitch({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const { pathname, search, hash } = useLocation();
  const chromeC = chrome[locale];
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<"first" | "last" | null>(null);
  const btnId = useId();
  const menuId = useId();

  const close = (refocus: boolean) => {
    if (!open) return;
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Open/close are the only places that touch `window`/`document`: the menu never renders on the
  // server (it starts closed), so this runs client-side only, same as ThemeSwitch's apply().
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + MENU_H + 8 > window.innerHeight;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    setPos({ top: up ? Math.max(8, r.top - MENU_H - 8) : r.bottom + 8, left });
    setOpen(true);
  };

  // Click outside closes; so does any scroll — the menu is position:fixed and would otherwise drift
  // off its button (it must escape `overflow-hidden` cards, e.g. the 偏好 group on /more).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // Keyboard-open focuses the first (ArrowDown) or last (ArrowUp) item once the menu exists.
  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
    const node = pendingFocus.current === "first" ? items?.[0] : items?.[items.length - 1];
    node?.focus();
    pendingFocus.current = null;
  }, [open]);

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      pendingFocus.current = e.key === "ArrowDown" ? "first" : "last";
      if (open) {
        // Already open: the arrows just move focus within the menu.
        const items = menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
        (e.key === "ArrowDown" ? items?.[0] : items?.[items.length - 1])?.focus();
        pendingFocus.current = null;
      } else {
        openMenu();
      }
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = items.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
    // Escape is handled on the wrapper (it also fires here by bubbling); Tab is left to the browser —
    // focus then leaves the wrapper and onBlur folds the menu.
  };

  return (
    <div
      ref={wrapRef}
      className={`relative notranslate ${className}`}
      translate="no"
      // Esc closes from wherever the focus sits inside the component (button or menu).
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          close(true);
        }
      }}
      // Tab out of the component folds the menu; React's onFocus/onBlur bubble (focusout semantics).
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={btnRef}
        id={btnId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={chromeC.langAria}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKeyDown}
        className="flex h-[34px] w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors duration-150 hover:bg-bg-sunk hover:text-ink"
      >
        <span className="shrink-0 text-ink-4" aria-hidden="true">
          <IconGlobe size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-left notranslate" translate="no">
          {LANGUAGES.find((l) => l.key === locale)?.name}
        </span>
        <IconChevronDown size={13} className={`shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={btnId}
          onKeyDown={onMenuKeyDown}
          className="fixed z-[60] w-[172px] rounded-card border border-line bg-surface p-1.5 shadow-[var(--shadow-card)]"
          style={{ top: pos.top, left: pos.left }}
        >
          {LANGUAGES.map((l) => {
            const current = l.key === locale;
            // `<Link to>` 必须是应用路径（不带 BASE_PATH）：React Router 在 basename 部署下会无条件再拼
            // 一次 basename，把 localePath() 的 public 路径交给它就得到 /geohot/geohot/... → 404
            // （本地根部署测不出来；2026-11-22 独立审查）。useLocation() 给的 pathname 本来就剥过前缀。
            const href = localeAppPath(pathname, l.key) + search + hash;
            return (
              <Link
                key={l.key}
                to={href}
                role="menuitem"
                lang={l.lang}
                hrefLang={l.lang}
                aria-current={current ? "true" : undefined}
                className={`flex items-center justify-between gap-3.5 rounded-control px-3 py-2 text-[14px] ${current ? "font-semibold text-ink" : "text-ink-2 hover:bg-bg-sunk"}`}
              >
                <span className="notranslate" translate="no">
                  {l.name}
                </span>
                {current && <IconCheck size={14} className="shrink-0 text-accent" />}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
