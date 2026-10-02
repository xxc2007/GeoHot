import { config } from "../config.ts";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string): string => `${config.siteUrl}${path}`;
export const itemUrl = (id: string): string => siteUrl(`/items/${id}`);
export const storyUrl = (publicId: string): string => siteUrl(`/story/${publicId}`);
export const dailyUrl = (date: string): string => siteUrl(`/daily/${date}`);
/** The page of any report kind; the path segment is the kind itself (`/weekly/2026-W39`, `/monthly/2026-09`). */
export const reportUrl = (kind: "daily" | "weekly" | "monthly", key: string): string => siteUrl(`/${kind}/${key}`);
export const storyApiUrl = (publicId: string): string => siteUrl(`/api/v1/stories/${publicId}`);
