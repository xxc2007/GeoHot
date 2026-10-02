// The river's line geometry, kept apart from the canvas so it can be tested. Both rules here used to live
// inside SignalRiver's draw loop, where they met in the worst way: the number of lines follows the width,
// while the hover remembers a line index from the river that was there before. Narrow the window with the
// pointer still over the river and `strands[hover.s]!` read nothing — the exception left a
// requestAnimationFrame callback (whose frame slot was already cleared, so the animation never rescheduled)
// right after `clearRect`, and the whole river stayed blank. Mobile rotation is the same event.
// A pure function instead of a non-null assertion, because the index really can be out of range.

/** Lines across a river this wide: 40 at the narrowest, 160 from 1200px up. */
export function strandCount(width: number): number {
  return Math.max(40, Math.min(160, Math.round(width / 7.5)));
}

/** What the pointer is over: one line, a whole bundle, the paper, or nothing. */
export interface RiverHover {
  s: number | null;
  bundle: number | null;
  paper: boolean;
}

/**
 * The lines a hover lights up. An index past the end of `strands` — a rebuild under a hover set before it —
 * lights nothing, which is what the reader should see: no line, rather than a broken frame.
 */
export function strandsUnderHover<T extends { bundle: number }>(strands: readonly T[], hover: RiverHover | null): T[] {
  if (!hover) return [];
  if (hover.bundle !== null) return strands.filter((s) => s.bundle === hover.bundle);
  if (hover.s === null) return [];
  const one = strands[hover.s];
  return one ? [one] : [];
}
