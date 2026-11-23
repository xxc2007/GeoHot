import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { loadOr404, withLang } from "../lib/api.server";
import { localeFromPath } from "../lib/i18n";

export { default, headers, meta } from "./item";

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeFromPath(new URL(request.url).pathname);
  const item = await loadOr404<SiteItemDetail>(withLang(`/api/site/items/${encodeURIComponent(params.id)}/original`, locale), { signal: request.signal });
  return { item };
}
