/** Resolve only the publisher's known, unresolved DW rendition token. Keep other URLs intact. */
export function normalizeSourceImageUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'static.dw.com') return value;
    const path = decodeURIComponent(url.pathname);
    if (!/^\/image\/\d+_\$\{formatId\}\.(?:jpg|jpeg|webp)$/i.test(path)) return value;
    // This concrete DW rendition was checked against the same image id (200, image/jpeg).
    url.pathname = path.replace('${formatId}', '605');
    return url.toString();
  } catch { return value; }
}
