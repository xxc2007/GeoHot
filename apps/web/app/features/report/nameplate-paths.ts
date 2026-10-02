// One nameplate logotype's two paths, taken out of the svg the generator wrote (scripts/nameplates.ts),
// so the component can draw them inline instead of pointing at the file. The generated shape is fixed:
// `<path id="accent" d="…"/><path id="ink" d="…"/>`. Nameplate.tsx says why inline beats a cross-document
// `<use href>` here; `apps/web/tests/nameplate.test.ts` pins this extractor to the four committed files,
// because a silent empty path would take the masthead out of every report page.

/** The `d` of the path carrying this id. */
export function nameplatePath(svg: string, id: "accent" | "ink"): string {
  const d = new RegExp(`id="${id}" d="([^"]+)"`).exec(svg)?.[1];
  if (!d) throw new Error(`nameplate: no path id="${id}" in the generated svg — scripts/nameplates.ts changed its format`);
  return d;
}
