// 英文读取层的模式开关与标签投影。
//
// 这里是 `/en` 的唯一策略入口。2026-11-23 验收把默认口径从 `fallback + parity` 翻到
// `strict + parity`：英文页是给英文读者的版面，缺英文时不再把中文标题/摘要/正文/刊面当成英文版
// 摆出来（`strict` 下成员门只放行英文文案当前的条目，正文退成 summary-licence，报刊与事件
// 不到英文就按「这一期/这一条还没有英文版」回答）。要恢复旧的中文回退行为，显式设
// `ENGLISH_TEXT=fallback`——一个目录里的中文读者仍读中文页。
// 只有英文源条目、没有中文译文的部署可以再切 `ENGLISH_MEMBERSHIP=english`
// （/en 单独服务英文源条目，不要求中文译文的第二条成员门）。
//
// 这个文件不做翻译、不调模型，只读开关与词表；读取层拿它决定「查哪一列」与「加哪一条门」。
import { hasChineseCopy } from "@aihot/contracts/copy";
import type { SiteLang, TextLocale } from "@aihot/contracts/site";

/** `ENGLISH_TEXT`：英文缺失时是否允许回退中文（默认不允许；显式 `fallback` 才允许）。 */
export type EnglishTextMode = "fallback" | "strict";
/** `ENGLISH_MEMBERSHIP`：/en 的成员集与中文列表一致（parity），还是单独按英文就绪（english）。 */
export type EnglishMembershipMode = "parity" | "english";

export function isSiteLang(value: unknown): value is SiteLang {
  return value === "zh" || value === "en";
}

export function englishTextMode(raw: string | undefined = process.env.ENGLISH_TEXT): EnglishTextMode {
  return raw === "fallback" ? "fallback" : "strict";
}

export function englishMembershipMode(raw: string | undefined = process.env.ENGLISH_MEMBERSHIP): EnglishMembershipMode {
  return raw === "english" ? "english" : "parity";
}

export function englishPolicy(): { text: EnglishTextMode; membership: EnglishMembershipMode } {
  return { text: englishTextMode(), membership: englishMembershipMode() };
}

/** 英文模式下是否要额外收紧（回退模式与今天同集，不追加任何门）。 */
export function strictEnglish(): boolean {
  return englishTextMode() === "strict";
}

/**
 * `textLocale` 的正确定义只有一种：标题与摘要都确实是英文才是 `en`；都带中文（或摘要为空、
 * 标题带中文）是 `zh`；一边英文一边中文/缺失才是 `mixed`。读取层按实际发出的字段算，
 * 前端不需要自己猜哪一段是中文。
 */
export function textLocaleOf(title: string | null | undefined, summary: string | null | undefined): TextLocale {
  const t = (title ?? "").trim();
  const s = (summary ?? "").trim();
  const titleEn = !!t && !hasChineseCopy(t);
  const summaryEn = !!s && !hasChineseCopy(s);
  if (titleEn && summaryEn) return "en";
  if ((!t || hasChineseCopy(t)) && (!s || hasChineseCopy(s))) return "zh";
  return "mixed";
}

/**
 * 读者标签的英文写法。标签词表本身（industry/taxonomy.ts）是中文身份，这里只做显示投影：
 * 未知标签原样回退，保证新词表标签在补翻译前不会消失。
 */
const TAG_LABELS_EN: Record<string, string> = {
  "高原": "Plateaus",
  "冰川与冻土": "Glaciers & permafrost",
  "地震": "Earthquakes",
  "火山": "Volcanoes",
  "海啸与风暴潮": "Tsunamis & storm surges",
  "中国科学院": "Chinese Academy of Sciences",
  "研究/发现": "Research & discovery",
  // 词表里的机构标签是中文；这些是 ENTITY_TAGS 的 rest 类，缺一行就会在 /en 卡片上原样漏中文。
  "欧空局": "European Space Agency",
  "自然资源部": "Ministry of Natural Resources",
  "应急管理部": "Ministry of Emergency Management",
  "民政部": "Ministry of Civil Affairs",
  "国家统计局": "National Bureau of Statistics",
  "水利部": "Ministry of Water Resources",
  "ESA": "ESA",
  "JAXA": "JAXA",
  "GDACS": "GDACS",
  "遥感影像": "Remote sensing imagery",
  "观测/数据发布": "Observations & data releases",
  "中国地震台网": "China Earthquake Networks Center",
  "预警/响应": "Early warning & response",
  "USGS": "USGS",
  "地质灾害": "Geohazards",
  "中国气象局": "China Meteorological Administration",
  "台风与寒潮": "Typhoons & cold waves",
  "气候异常": "Climate anomalies",
  "NOAA": "NOAA",
  "海平面": "Sea level",
  "NASA": "NASA",
  "哥白尼计划": "Copernicus",
  "灾害事件": "Disaster events",
  "技术与软件": "Technology & software",
  "世界气象组织": "WMO",
  "IPCC": "IPCC",
  "OpenStreetMap": "OpenStreetMap",
  "地图与制图": "Cartography & mapping",
  "GIS与空间数据": "GIS & spatial data",
  "联合国粮农组织": "FAO",
  "土壤": "Soils",
  "生态与保护": "Ecology & conservation",
  "洪水与干旱": "Floods & droughts",
  "水资源": "Water resources",
  "地貌": "Landforms",
  "平原": "Plains",
  "海洋": "Oceans",
  "植被": "Vegetation",
  "城市化": "Urbanization",
  "城市地理": "Urban geography",
  "交通地理": "Transport geography",
  "人口迁移": "Migration",
  "乡村地理": "Rural geography",
  "产业区位": "Industrial location",
  "经济地理": "Economic geography",
  "能源与资源": "Energy & resources",
  "行政区划调整": "Administrative division changes",
  "政治地理": "Political geography",
  "卫星导航": "Satellite navigation",
  "地图与图集": "Maps & atlases",
  "政策/规划": "Policy & planning",
  "科普/教程": "Explainers & tutorials",
  "评论/解读": "Commentary & analysis",
  "考察/记录": "Fieldwork & records",
  "机构/动态": "Institutions",
  "非地理/通用": "Non-geography / general",
  "其他": "Other",
};

export function tagLabelEn(tag: string): string {
  return TAG_LABELS_EN[tag] ?? tag;
}