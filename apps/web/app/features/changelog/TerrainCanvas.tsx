import { useEffect, useRef } from "react";

// Shared vector geometry for the static fallback and animated scan-line relief.
const TWO = "M449 86 C450 36 475 12 518 12 C566 12 591 36 591 77 C591 114 567 140 535 165 L493 200 H594 V235 H445 V208 C445 174 474 151 512 120 C540 98 551 87 551 70 C551 53 540 43 523 43 C503 43 490 57 489 86 Z";
const ZERO = "M733 12 C791 12 813 51 813 124 C813 198 791 239 733 239 C677 239 654 198 654 124 C654 51 677 12 733 12 Z M733 48 C706 48 696 71 696 124 C696 178 706 203 733 203 C760 203 771 178 771 124 C771 71 760 48 733 48 Z";
const DOT = "M612 201 H642 V235 H612 Z";
const ROWS = 43, COLS = 360, W = 1000, H = 260;

function StillContours() {
  return <svg viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true" className="major-terrain-fallback">
    <defs><pattern id="major-lines" width="1000" height="5.5" patternUnits="userSpaceOnUse"><path d="M0 0H1000" stroke="currentColor" strokeWidth="1.2" /></pattern></defs>
    <g opacity=".2">{Array.from({ length: ROWS }, (_, i) => <path key={i} d={`M0 ${20 + i * 5.5}H1000`} stroke="currentColor" strokeWidth=".7" />)}</g>
    <g fill="url(#major-lines)" fillRule="evenodd"><path d={TWO} /><path d={DOT} /><path d={ZERO} /></g>
  </svg>;
}

export function TerrainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const mask = document.createElement("canvas"); mask.width = W; mask.height = H;
    const brush = mask.getContext("2d", { willReadFrequently: true });
    if (!brush) return;
    brush.fillStyle = "white"; brush.filter = "blur(2px)";
    for (const path of [TWO, DOT, ZERO]) brush.fill(new Path2D(path), "evenodd");
    const pixels = brush.getImageData(0, 0, W, H).data;
    const relief = Array.from({ length: ROWS }, (_, row) => Float32Array.from({ length: COLS + 1 }, (_, col) => {
      const x = Math.min(W - 1, Math.round(col / COLS * W));
      return pixels[(Math.round(20 + row * 5.5) * W + x) * 4 + 3]! / 255;
    }));
    let width = 1, height = 1, visible = false, frame = 0, previous = 0, phase = 0;
    const pointer = { x: 700, y: 120, strength: 0, target: 0 };
    const draw = () => {
      context.clearRect(0, 0, width, height);
      const color = getComputedStyle(canvas).color;
      const fade = context.createLinearGradient(0, 0, width, 0);
      fade.addColorStop(0, "transparent"); fade.addColorStop(.04, color); fade.addColorStop(.96, color); fade.addColorStop(1, "transparent");
      for (let row = 0; row < ROWS; row++) {
        const points: { x: number; y: number; ink: number }[] = [];
        for (let col = 0; col <= COLS; col++) {
          const x = col / COLS * W, base = 20 + row * 5.5, ink = relief[row]![col]!;
          const distance = ((x - pointer.x) / 95) ** 2 + ((base - pointer.y) / 70) ** 2;
          const ripple = Math.exp(-distance) * Math.sin((x - pointer.x) / 34 + phase * 2) * pointer.strength * 9;
          const wave = media.matches ? 0 : Math.sin(x / 125 + phase + row * .14) * 1.1;
          points.push({ x: x / W * width, y: (base - ink * 15 + wave + ripple) / H * height, ink });
        }
        context.beginPath(); points.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
        context.strokeStyle = fade; context.globalAlpha = .23; context.lineWidth = .7; context.stroke();
        context.beginPath(); let connected = false;
        for (const p of points) {
          if (p.ink > .08) { if (connected) context.lineTo(p.x, p.y); else context.moveTo(p.x, p.y); connected = true; }
          else connected = false;
        }
        context.strokeStyle = color; context.globalAlpha = .9; context.lineWidth = 1.15; context.stroke();
        if (!media.matches && row % 13 === 6) {
          const start = ((phase * 38 + row * 73) % 940) / W * width;
          context.beginPath(); context.moveTo(start, points[0]!.y); context.lineTo(Math.min(width, start + width * .045), points[0]!.y);
          context.globalAlpha = .65; context.stroke();
        }
      }
      context.globalAlpha = 1; canvas.dataset.painted = "true";
    };
    const active = () => visible && !document.hidden && !media.matches;
    const tick = (now: number) => {
      frame = 0;
      if (!active()) return;
      if (now - previous >= 1000 / 24) {
        phase += Math.min((now - previous) / 1000 || 0, .1) * .65;
        pointer.strength += (pointer.target - pointer.strength) * .18;
        previous = now; draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame); frame = 0; previous = 0;
      canvas.dataset.running = String(active());
      if (active()) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      const box = canvas.getBoundingClientRect(); width = Math.max(1, box.width); height = Math.max(1, box.height);
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0); draw();
    };
    const changed = () => { sync(); draw(); };
    const observer = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; sync(); }, { threshold: .05 });
    const size = new ResizeObserver(resize);
    const point = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = Math.max(0, Math.min(W, (event.clientX - box.left) / box.width * W));
      pointer.y = Math.max(0, Math.min(H, (event.clientY - box.top) / box.height * H));
      pointer.target = 1; pointer.strength = .8;
      if (visible) draw();
    };
    const leave = () => { pointer.target = 0; };
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") { pointer.x = 700; pointer.y = 120; pointer.strength = pointer.target = 0; }
      else { pointer.x = Math.max(0, Math.min(W, pointer.x + (event.key === "ArrowRight" ? 45 : event.key === "ArrowLeft" ? -45 : 0))); pointer.y = Math.max(0, Math.min(H, pointer.y + (event.key === "ArrowDown" ? 25 : event.key === "ArrowUp" ? -25 : 0))); pointer.strength = pointer.target = 1; }
      draw();
    };
    observer.observe(canvas); size.observe(canvas); resize(); sync();
    canvas.addEventListener("pointermove", point); canvas.addEventListener("pointerdown", point); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("pointerup", leave); canvas.addEventListener("pointercancel", leave); canvas.addEventListener("keydown", key); canvas.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", sync); media.addEventListener("change", changed);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); size.disconnect();
      canvas.removeEventListener("pointermove", point); canvas.removeEventListener("pointerdown", point); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("pointerup", leave); canvas.removeEventListener("pointercancel", leave); canvas.removeEventListener("keydown", key); canvas.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", sync); media.removeEventListener("change", changed);
    };
  }, []);
  return <div className="major-terrain-wrap"><div className="major-terrain">
    <StillContours />
    <canvas ref={canvasRef} tabIndex={0} role="img" aria-label="GEOHOT 2.0 动态等高线" />
    <span className="major-terrain-word" aria-hidden="true">GEOHOT</span>
  </div></div>;
}
