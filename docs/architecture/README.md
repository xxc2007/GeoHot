# Architecture diagram exports

Edit the bilingual copy and layout in render.mjs. The SVG remains the editable source; README previews and click targets use a 3600-pixel-wide PNG exported from that same SVG. No diagram nodes or labels are rewritten during rasterisation.

From the repository root:

```sh
npm ci --prefix docs/architecture
node docs/architecture/render.mjs
```

The exporter uses pinned @resvg/resvg-js 2.6.2 and system fonts. Install a Chinese font such as Microsoft YaHei on Windows or Noto Sans CJK SC on Linux before rendering the Chinese edition. Keep fonts consistent when comparing raster output across machines. Rendering is a local documentation task; production does not need this tool or a service restart.

images.json records the SVG and PNG hashes, pixel dimensions and byte counts. PNG filenames contain a content hash to avoid stale image caches; README links open raw.githubusercontent.com directly so the browser can switch from fit-to-window to original-size zoom. Earlier exports are retained.

## Change record

2026-10-28: README diagrams now use high-resolution PNG previews with a direct original-size image link. The existing SVG content is preserved.
