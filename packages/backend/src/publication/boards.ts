// Board data layer: the four cross-category sections the site owner asked for (考研 / 地理信息系统 /
// 地理与政治 / 地理与历史). A board is a *view* over one or two taxonomy categories — it adds no new
// visibility rule, and it deliberately keeps two lanes apart:
//
//   本站精选  — selected items (the human-curated set; the same gate topic pages use)
//   来源原文  — everything else that the read layer already publishes: listed but unselected, so the
//               source's own headline and link carry it, and nothing on this lane is our judgement
//
// The second lane exists because production publishes far more than the 53 curated items, and putting it
// behind the same gate would have hidden it. It is labelled in the UI, never mixed into 精选, and never
// reaches facts, events, heat or the daily paper (those read the selected set only).
//
// Flood control is part of the data layer, not the page: one alert source can publish hundreds of rows a
// day (measured 2026-10-03: 100/100 of the freshest items came from one 气象台预警 source), so the index
// lane collapses repeats — at most three rows from one source, the rest summarised as a count the UI shows
// as 「＋N 条来自同一来源」.
import type { FeedItemSummary } from "@aihot/contracts/site";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { ITEM_COLUMNS, ITEM_FROM, listedCondition, selectedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";

export interface BoardDefinition {
  slug: string;
  name: string;
  /** The plate mark the page draws for this board (features/board/PlateMark.tsx). */
  plate: "scale" | "graticule" | "hachure" | "strata";
  categories: string[];
  description: string;
}

export const BOARD_PAGE_SIZE = 20;
/** How many rows from one source the index lane shows before collapsing the rest into a count. */
export const BOARD_INDEX_PER_SOURCE = 3;

const boardsCache = cached(
  async () => {
    const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/boards.json"), "utf8")) as { boards: BoardDefinition[] };
    return data.boards;
  },
  { freshMs: 60_000, maxStaleMs: 10 * 60_000 },
);

export function listBoardDefinitions(): Promise<BoardDefinition[]> {
  return boardsCache.get();
}

export async function loadBoardDefinition(slug: string): Promise<BoardDefinition | null> {
  return (await listBoardDefinitions()).find((b) => b.slug === slug) ?? null;
}

export interface BoardCounts {
  curated: number;
  index: number;
}

/** Both lanes' sizes per board, read together so the two numbers describe one instant. */
export async function boardCounts(at = new Date()): Promise<Record<string, BoardCounts>> {
  const boards = await listBoardDefinitions();
  const rows = await sql<{ category: string | null; curated: number; index: number }[]>`
    SELECT p.category,
           count(*) FILTER (WHERE p.selected)::int AS curated,
           count(*) FILTER (WHERE NOT p.selected)::int AS index
    FROM publications p
    WHERE p.visibility = 'public' AND ${listedCondition(at)} AND p.category = ANY(${boards.flatMap((b) => b.categories)}::text[])
    GROUP BY 1`;
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  const out: Record<string, BoardCounts> = {};
  for (const b of boards) {
    let curated = 0;
    let index = 0;
    for (const c of b.categories) {
      curated += byCategory.get(c)?.curated ?? 0;
      index += byCategory.get(c)?.index ?? 0;
    }
    out[b.slug] = { curated, index };
  }
  return out;
}

export interface BoardLane {
  items: FeedItemSummary[];
  /** Index-lane rows hidden by the per-source cap, newest source first. */
  collapsed: Array<{ sourceId: string; sourceName: string; count: number }>;
}

export interface BoardView {
  board: BoardDefinition;
  counts: BoardCounts;
  curated: BoardLane;
  index: BoardLane;
  page: number;
  pageCount: number;
}

/**
 * The index lane is paginated over raw rows and collapsed after paging: page 2 continues where page 1's
 * raw window ended, so a reader never sees the same row twice. The collapsed counts describe the window
 * the page was cut from, which is what the UI's 「＋N 条」 line means.
 */
async function loadLane(
  categories: string[],
  lane: "curated" | "index",
  page: number,
  now: Date,
): Promise<BoardLane> {
  const gate = lane === "curated" ? sql`${selectedCondition(now)}` : sql`${listedCondition(now)} AND NOT p.selected`;
  const offset = (page - 1) * BOARD_PAGE_SIZE;
  const rows = await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
    WHERE ${gate} AND p.category = ANY(${categories}::text[])
    ORDER BY p.timeline_at DESC, p.article_id DESC
    LIMIT ${BOARD_PAGE_SIZE} OFFSET ${offset}`;
  if (lane === "curated") return { items: rows.map(toFeedItemSummary), collapsed: [] };
  const seen = new Map<string, number>();
  const kept: ItemRow[] = [];
  for (const row of rows) {
    const n = (seen.get(row.source_id) ?? 0) + 1;
    seen.set(row.source_id, n);
    if (n <= BOARD_INDEX_PER_SOURCE) kept.push(row);
  }
  const collapsed = [...seen.entries()]
    .filter(([, n]) => n > BOARD_INDEX_PER_SOURCE)
    .map(([sourceId, n]) => ({ sourceId, sourceName: rows.find((r) => r.source_id === sourceId)!.source_name, count: n - BOARD_INDEX_PER_SOURCE }));
  return { items: kept.map(toFeedItemSummary), collapsed };
}

export async function viewBoard(slug: string, page = 1, at?: Date): Promise<BoardView | null> {
  const board = await loadBoardDefinition(slug);
  if (!board || page < 1) return null;
  const now = at ?? new Date();
  const counts = (await boardCounts(now))[board.slug];
  if (!counts) return null;
  const pageCount = Math.max(1, Math.ceil(Math.max(counts.curated, counts.index) / BOARD_PAGE_SIZE));
  if (page > pageCount) return null;
  const [curated, index] = await Promise.all([
    loadLane(board.categories, "curated", page, now),
    loadLane(board.categories, "index", page, now),
  ]);
  return { board, counts, curated, index, page, pageCount };
}
