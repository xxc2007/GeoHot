import { useState } from "react";
import type { MediaView } from "@aihot/contracts/site";
import { Lightbox } from "../../components/ui/Lightbox";

/** A round play mark over a video's still. */
function PlayMark() {
  return (
    <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
      <span className="grid size-11 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/30 backdrop-blur-sm transition-transform duration-200 group-hover:scale-105">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5">
          <path d="M7 4.5v15a1 1 0 001.5.87l13-7.5a1 1 0 000-1.74l-13-7.5A1 1 0 007 4.5z" />
        </svg>
      </span>
    </span>
  );
}

/**
 * The post's pictures as tiles, all of them (X allows up to nine; list cards show four). Images open in
 * a viewer that steps through them; videos are only a still in our data, so they open the original post.
 */
export function MediaGallery({ media, postUrl, videoLabel }: { media: MediaView[]; postUrl: string; videoLabel: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = media.slice(0, 9);
  const images = shown.filter((m) => m.kind !== "video");
  // A gallery picture is the post's content, never decoration: with no description from its author, say
  // which one it is instead of claiming there is nothing to say. A video tile's still is decoration —
  // its link label already says what it opens.
  const altOf = (m: MediaView) =>
    m.alt ?? (m.kind === "video" ? "" : `配图${images.length > 1 ? ` ${images.indexOf(m) + 1}/${images.length}` : ""}（来源未提供说明）`);
  const single = shown.length === 1;
  const tile = `group relative overflow-hidden rounded-tile border border-line-soft bg-bg-sunk ${single ? "max-w-[420px]" : "aspect-[16/10]"}`;
  return (
    <>
      <div className={`mt-5 grid gap-2 ${single ? "grid-cols-1" : shown.length === 2 || shown.length === 4 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"}`}>
        {shown.map((m) => {
          const alt = altOf(m);
          const img = (
            <img
              src={m.poster ?? m.url}
              srcSet={m.srcSet}
              sizes={single ? "auto, (min-width: 460px) 420px, calc(100vw - 32px)" : "auto, (min-width: 800px) 248px, (min-width: 640px) calc(33.333vw - 19px), calc(50vw - 24px)"}
              width={m.width ?? undefined}
              height={m.height ?? undefined}
              decoding="async"
              alt={alt}
              loading="lazy"
              className={`block w-full object-cover transition-transform duration-300 group-hover:scale-[1.015] ${single ? "max-h-[360px]" : "h-full"}`}
              style={single && m.width && m.height ? { aspectRatio: `${m.width} / ${m.height}` } : undefined}
            />
          );
          return m.kind === "video" ? (
            <a key={m.url} href={postUrl} target="_blank" rel="noopener noreferrer" aria-label={videoLabel} className={tile}>
              {img}
              <PlayMark />
            </a>
          ) : (
            <button key={m.url} type="button" onClick={() => setOpen(images.indexOf(m))} aria-label={`查看大图：${alt}`} className={`${tile} cursor-zoom-in`}>
              {img}
            </button>
          );
        })}
      </div>
      <Lightbox images={images.map((m) => ({ src: m.url, alt: altOf(m) }))} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}
