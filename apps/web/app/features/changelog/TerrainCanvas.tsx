import { useEffect, useRef, useState } from "react";

/** A local contour drawing: no texture, animation library or network request. */
export function TerrainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(0);
  const input = useRef({ x: 0.68, y: 0.5 });
  const [paused, setPaused] = useState(false);
  const [replay, setReplay] = useState(0);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false, frame = 0, previous = 0, phase = phaseRef.current;
    let width = 1, height = 1;
    const draw = () => {
      const color = getComputedStyle(canvas).color;
      context.clearRect(0, 0, width, height);
      context.strokeStyle = color;
      const center = 0.55 + input.current.x * 0.22;
      for (let row = 0; row < 29; row++) {
        context.beginPath();
        for (let col = 0; col <= 80; col++) {
          const x = col / 80;
          const ridge = Math.exp(-(((x - center) / 0.14) ** 2)) * 0.45 + Math.exp(-(((x - center - 0.17) / 0.09) ** 2)) * 0.2;
          const wave = Math.sin(x * 11 + phase + row * 0.14) * 0.012;
          const y = 0.28 + row / 44 - (ridge + wave) * Math.sin(Math.PI * (row + 1) / 32) * (0.7 + input.current.y * 0.45);
          if (col) context.lineTo(x * width, y * height); else context.moveTo(x * width, y * height);
        }
        context.lineWidth = row % 5 === 0 ? 1.3 : 0.7;
        context.globalAlpha = row % 5 === 0 ? 0.78 : 0.28;
        context.stroke();
      }
      context.globalAlpha = 1;
      canvas.dataset.painted = "true";
    };
    const active = () => visible && !document.hidden && !paused && !media.matches;
    const tick = (now: number) => {
      frame = 0;
      if (!active()) return;
      // Cap at 24 fps and retain time-based movement on slower devices.
      if (now - previous >= 1000 / 24) {
        phase += Math.min((now - previous) / 1000 || 0, 0.1) * 0.65;
        phaseRef.current = phase;
        previous = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame); frame = 0; previous = 0;
      canvas.dataset.running = String(active());
      if (active()) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      width = Math.max(1, box.width); height = Math.max(1, box.height);
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0); draw();
    };
    const changed = () => { setReduced(media.matches); sync(); draw(); };
    const observer = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; sync(); }, { threshold: 0.05 });
    const size = new ResizeObserver(resize);
    const point = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      input.current = { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
      if (visible) draw();
    };
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") input.current = { x: 0.68, y: 0.5 };
      else {
        input.current.x = Math.max(0, Math.min(1, input.current.x + (event.key === "ArrowRight" ? 0.1 : event.key === "ArrowLeft" ? -0.1 : 0)));
        input.current.y = Math.max(0, Math.min(1, input.current.y + (event.key === "ArrowDown" ? 0.1 : event.key === "ArrowUp" ? -0.1 : 0)));
      }
      draw();
    };
    observer.observe(canvas); size.observe(canvas); resize(); changed();
    canvas.addEventListener("pointermove", point); canvas.addEventListener("pointerdown", point); canvas.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", sync); media.addEventListener("change", changed);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); size.disconnect();
      canvas.removeEventListener("pointermove", point); canvas.removeEventListener("pointerdown", point); canvas.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", sync); media.removeEventListener("change", changed);
    };
  }, [paused, replay]);
  return <div className="major-terrain-wrap">
    <div className="major-terrain">
      <svg viewBox="0 0 1000 260" aria-hidden="true" className="major-terrain-fallback">
        {Array.from({ length: 15 }, (_, i) => <path key={i} d={`M0 ${80 + i * 10} C420 ${90 + i * 10} 490 ${110 + i * 5} 640 ${30 + i * 7} S820 ${85 + i * 5} 1000 ${75 + i * 11}`} fill="none" stroke="currentColor" opacity={0.2 + (i % 3) * 0.14} />)}
      </svg>
      <canvas ref={canvasRef} tabIndex={0} role="img" aria-label="可交互地理山脊：移动指针或触摸改变山形，方向键微调，Home 复位" />
      <span className="major-terrain-word" aria-hidden="true">GEOHOT<span>每一条线索，都有来处。</span></span>
    </div>
    <div className="major-motion-controls">
      <span>移动指针 / 触摸山脊 · 方向键微调</span>
      <div><button type="button" onClick={() => setPaused(value => !value)} aria-pressed={paused || reduced} disabled={reduced}>{reduced ? "已减少动态" : paused ? "继续动态" : "暂停动态"}</button>
      <button type="button" onClick={() => { input.current = { x: 0.68, y: 0.5 }; phaseRef.current = 0; setPaused(false); setReplay(value => value + 1); }}>重播 / 复位</button></div>
    </div>
  </div>;
}
