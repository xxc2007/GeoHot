// The dot grid in the masthead's 报眼, beside the date: one dot per day of the month (dailies), week
// of the year (weeklies) or month (monthlies). Issues that exist are ink dots, this issue is a larger
// teal dot in a ring, the rest are faint. Hover names the day and its issue; a click opens it. Drawn
// on a canvas in the same dot language as the nameplate — and the links over it are real `<a>`s, so the
// grid is not a mouse-only surface: keyboard and screen-reader readers get the same issues the archive
// column lists, one anchor per dot, named by the hover text the pointer gets.
import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { KIND_PATH, periodGrid } from "./format";

const ROW = 20;
const TAU = Math.PI * 2;
const INTRO_MS = 700;
const easeOutBack = (p: number) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2;

export function IssueDots({ kind, reportKey, index, className = "" }: { kind: ReportKind; reportKey: string; index: ReportNavigationEntry[]; className?: string }) {
  const grid = useMemo(() => periodGrid(kind, reportKey, index), [kind, reportKey, index]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Pointer tracking lives on the box that holds both the canvas and the links over it: an event that
  // lands on a link never reaches the canvas underneath, so listening on the canvas left the dots dead
  // to the pointer the moment they became clickable.
  const boxRef = useRef<HTMLDivElement>(null);
  const rows = Math.ceil(grid.cells.length / grid.columns);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !box) return;
    const { cells, columns } = grid;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let cw = 0;
    let hovered = -1;
    let started = 0;
    let frame = 0;
    let disposed = false;
    let colors = { ink: "#000", accent: "#000", idle: "#ccc" };

    const readColors = () => {
      const root = getComputedStyle(document.documentElement);
      colors = {
        ink: root.getPropertyValue("--ink").trim() || "#000",
        accent: root.getPropertyValue("--accent").trim() || "#000",
        idle: root.getPropertyValue("--line-strong").trim() || "#ccc",
      };
    };
    const size = () => {
      width = canvas.clientWidth;
      if (!width) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      cw = width / columns;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(rows * ROW * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (now: number) => {
      frame = 0;
      if (disposed || !width) return;
      const t = still ? 1 : Math.min(1, (now - started) / INTRO_MS);
      ctx.clearRect(0, 0, width, rows * ROW);
      const unit = Math.min(cw, ROW);
      cells.forEach((c, i) => {
        if (c.state === "pad") return;
        const p = Math.min(1, Math.max(0, t * 1.6 - (i / cells.length) * 0.6));
        if (p <= 0) return;
        const grow = easeOutBack(p) * (i === hovered ? 1.4 : 1);
        const x = ((i % columns) + 0.5) * cw;
        const y = (Math.floor(i / columns) + 0.5) * ROW;
        const r = (c.state === "current" ? 0.26 : c.state === "issue" ? 0.17 : 0.08) * unit * grow;
        ctx.fillStyle = c.state === "current" ? colors.accent : c.state === "issue" ? colors.ink : colors.idle;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        if (c.state === "current") {
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, unit * 0.42 * easeOutBack(p), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
      if (t < 1) frame = requestAnimationFrame(draw);
    };
    const redraw = () => {
      if (width && !frame) frame = requestAnimationFrame(draw);
    };

    const cellAt = (e: PointerEvent | MouseEvent) => {
      const rect = box.getBoundingClientRect();
      const col = Math.floor((e.clientX - rect.left) / cw);
      const row = Math.floor((e.clientY - rect.top) / ROW);
      const i = row * columns + col;
      return col >= 0 && col < columns && i >= 0 && i < cells.length ? i : -1;
    };
    // A cell whose dot is worth pointing at: this issue, or one you can open. The faint ones have nothing
    // behind them, so they hold no focus and carry no name.
    const onMove = (e: PointerEvent) => {
      const i = cellAt(e);
      const c = cells[i];
      box.style.cursor = c?.state === "issue" ? "pointer" : "default";
      box.title = c && c.state !== "pad" ? c.label : "";
      const next = c && c.state !== "none" && c.state !== "pad" ? i : -1;
      if (next !== hovered) {
        hovered = next;
        redraw();
      }
    };
    const onLeave = () => {
      hovered = -1;
      box.title = "";
      box.style.cursor = "default";
      redraw();
    };

    // One size-and-paint per frame: the observer fires for every step of a drag, and `size` resizes the
    // canvas backing store (which clears it) and redraws the whole grid.
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        size();
        redraw();
      });
    });
    const recolour = () => {
      readColors();
      redraw();
    };
    const theme = new MutationObserver(recolour);
    const scheme = matchMedia("(prefers-color-scheme: dark)");

    readColors();
    size();
    started = performance.now();
    redraw();
    resize.observe(canvas);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    scheme.addEventListener("change", recolour);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resize.disconnect();
      theme.disconnect();
      scheme.removeEventListener("change", recolour);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerleave", onLeave);
    };
  }, [grid, rows, kind]);

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between text-label text-ink-4">
        <span className="font-semibold tracking-[0.2em] text-ink-2">{grid.title}</span>
        <span className="num">{grid.note}</span>
      </div>
      {grid.heads && (
        <div className="mt-2 grid text-center text-micro leading-none text-ink-4" style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}>
          {grid.heads.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      )}
      {/* The canvas paints, the anchors navigate: the same grid, one cell per dot, laid out by the same
          columns × 20px rows the drawing uses, so each link sits exactly on its dot. */}
      <div ref={boxRef} className="relative mt-1" style={{ height: rows * ROW }}>
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 block size-full" />
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, ${ROW}px)` }}>
          {grid.cells.map((c, i) =>
            // Every cell gets an element: auto-placement in the grid is positional, and a cell that
            // rendered nothing would pull the anchors after it one dot to the left.
            c.state === "issue" && c.key ? (
              <Link key={i} to={`${KIND_PATH[kind]}/${c.key}`} aria-label={c.label} title={c.label} className="rounded-tile outline-offset-[-2px]" />
            ) : c.state === "current" ? (
              <span key={i} aria-current="page" className="grid place-items-center" title={c.label}>
                <span className="sr-only">{c.label}</span>
              </span>
            ) : (
              <span key={i} aria-hidden="true" />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
