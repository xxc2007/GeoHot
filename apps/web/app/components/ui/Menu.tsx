import { useEffect, useRef, useState, type ReactNode } from "react";
import { Presence } from "./Presence";

/** A small dropdown anchored to a trigger; closes on outside click, Escape or choosing an entry. */
export function Menu({ trigger, label, children, align = "right" }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 焦点曾经落在菜单里吗？只有键盘/触屏进来的那次才需要还回去，鼠标点空白处关掉不该抢焦点。
  const hadFocus = useRef(false);
  /**
   * 菜单项之间用方向键走（APG 的 menu 模式）。原先只有 Escape 与"焦点归位"两件，
   * 而 role="menu" 声明出去之后，读屏用户按惯例会拿方向键试——那两下没人接，焦点就卡在原地。
   * 打开时把焦点交给第一项（键盘和鼠标都一样：鼠标用户看不见焦点环，键盘用户立刻能按方向键）。
   */
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  useEffect(() => {
    if (!open) {
      // 关菜单时把焦点交回触发按钮：菜单项跟着 Presence 的 140 ms 退出动画就卸载了，
      // 还留在里面的键盘用户不该掉回 <body>（重头 Tab 一遍）。
      if (hadFocus.current) {
        hadFocus.current = false;
        triggerRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    items()[0]?.focus({ preventScroll: true });
    // 焦点是我们刚放进去的，所以"关的时候要还回去"从这一刻起成立；
    // 但点空白处关掉、或按 Tab 走出去，都不该把焦点抢回触发按钮——下面两处各自把它清掉。
    hadFocus.current = true;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        hadFocus.current = false;
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onFocusIn = (e: FocusEvent) => {
      if (ref.current?.contains(e.target as Node)) hadFocus.current = true;
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    ref.current?.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      ref.current?.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    // Tab 走出菜单 = 关掉它：不关的话菜单还挂在那儿，焦点却已经去了别处。
    // 这一下也不还焦点（用户正要去别的地方），所以把"还回去"的标志清掉。
    if (e.key === "Tab") {
      hadFocus.current = false;
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus({ preventScroll: true });
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus({ preventScroll: true });
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus({ preventScroll: true });
    }
  };
  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`inline-flex size-8 items-center justify-center rounded-control transition-colors ${open ? "bg-bg-sunk text-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
      >
        {trigger}
      </button>
      <Presence show={open} enter="anim-drop-in" exit="anim-drop-out" duration={140}>
        <div
          role="menu"
          onKeyDown={onMenuKey}
          className={`absolute top-10 z-50 min-w-[168px] overflow-hidden rounded-tile border border-line bg-raised py-1 shadow-[var(--shadow-pop)] ${align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left"}`}
        >
          {children(() => setOpen(false))}
        </div>
      </Presence>
    </div>
  );
}

/** One entry of a Menu (a button or a link). */
export function MenuItem({ icon, children, onSelect, href, download }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; href?: string; download?: boolean }) {
  const cls = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink";
  const inner = (
    <>
      {icon && <span className="text-ink-4">{icon}</span>}
      {children}
    </>
  );
  if (href) {
    return (
      <a role="menuitem" href={href} download={download} onClick={onSelect} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onSelect} className={cls}>
      {inner}
    </button>
  );
}
