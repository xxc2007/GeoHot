import { UUID_PATTERN } from "@aihot/contracts/taxonomy";
import type { StoryFollowupsResponse } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { loadDevelopments } from "./groups.ts";

/**
 * A short reading-page list, using the same publication/filter rules as the full event.
 *
 * `loadDevelopments` answers `not_found` for two different situations: the story does not exist, and the
 * story exists but has no *selected* report yet (an item page mounts this block for every item carrying a
 * story ref; an index row's story is exactly that case). Collapsing both into the route's 404 made the
 * reader-facing block retry a request that can never succeed — live on 2026-10-03, every unselected item
 * with a story showed 「事件后续暂时无法加载，点击重试」 forever. So: a missing story stays not-found
 * (null → 404); a story with nothing published yet answers an empty list (200).
 */
export async function loadStoryFollowups(storyPublicId: string): Promise<StoryFollowupsResponse | null> {
  const result = await loadDevelopments({ storyPublicId, channel: "all", category: null, tag: null, topicTags: null, cursor: null, revision: null, take: 8 });
  if (result.kind === "not_found") {
    if (!UUID_PATTERN.test(storyPublicId)) return null;
    const [story] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE public_id = ${storyPublicId} AND merged_into IS NULL`;
    return story ? { items: [], more: false } : null;
  }
  if (result.kind !== "ok") return null;
  return { items: result.body.developments.map(({ factId, representative: r }) => ({ factId, representative: { id: r.id, title: r.title, source: { name: r.source.name }, timelineAt: r.timelineAt } })), more: !!result.body.nextCursor };
}
