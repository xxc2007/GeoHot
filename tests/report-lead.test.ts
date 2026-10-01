// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string) => ({ itemId, title }) as ReportCitation;
const ranking = cite("a", "Sentinel-2 全球年度基础图件覆盖率达 98%，位居开源卫星影像数据首位");
const embargo = cite("b", "自然资源部暂停一批高精度DEM成果的对外分发，披露部分图层在授权范围外被第三方平台镜像并泄露了接口凭据等安全问题");

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf("自然资源部暂停一批DEM成果对外分发，披露接口凭据泄露等安全问题", [ranking, embargo], [ranking, embargo])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf("多家机构发布新版地形图，底图服务竞争加剧", [ranking], [ranking, embargo]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [ranking], [embargo, ranking])?.itemId, "a");
});
