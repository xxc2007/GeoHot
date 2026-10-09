// 这个行业的分类体系：类别、标签词表、机构（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉模型怎么归类。
 * section 现在只有两节（学科、技术）：reports/compose.ts 取 `SECTION_ORDER.at(-1)` 作为「没有类别的资料」
 * 的兜底分节，而 SECTION_ORDER 就是本数组 section 字段的**首现顺序**。兜底分节由首现顺序决定，不由数组
 * 末位决定——2026-10-03 把「地理信息系统」提到「考研」之前之后，末位类别（考研，学科）一度不是兜底节（技术）
 * 的类别；2026-10-09 删掉「考研」之后末位又变回了 geotech（技术）。**两次都能碰巧对上，所以末位看起来像判据，
 * 但它不是**：兜底节只由 section 的首现顺序决定。别再把「末位类别」当成兜底节的判据，也别用末位键去筛分类
 * （`tests/report-default-section.test.ts` 里那条钉的就是末位键，改顺序时它会提醒你来重推一遍死值）。
 * 所以加类别只有两种安全写法：**复用已有两节里的某一节**，或插在一个同节类别旁边；给新类别起第三个节名，
 * 会让所有没有类别的资料一夜之间搬进那一节。
 * 这条不变量由 `tests/report-default-section.test.ts` 钉住（它按 compose.ts 的同一段算式对拍死值）。
 * 2026-10-08 按站长要求把「地理与政治」「地理与历史」改成学科本名「政治地理」「历史地理」：label 是读者看到的
 * 说法（筛选栏、卡片角标、RSS 分类订阅、日报分节），key 一个都没动，所以网址、库里的值、API/MCP 枚举全部照旧。
 * 改名后 geopolitics 的 label 与 TOPIC_TAGS 的「政治地理」同名不是笔误：卡片上类别不带 #、标签带 #，两者链到
 * `/all?category=geopolitics` 与 `/all?tag=政治地理` 两个不同入口，主题标签那一格另有四个主题页在用（见上面 TAG_SYNONYMS 的注）。
 * 2026-10-09 按站长要求**删掉「考研」`geoedu`**（七个分类变六个）。key 一旦从这张表消失，`isCategoryKey` 就不认它了：
 * 库里残留的 `category='geoedu'` 行在读侧一律按「没有分类」走（`toPublicApiCategory` → null，`/all?category=geoedu`
 * 与任何未知键一样回落到全部），所以迁移 `0049` 把那 1 行显式改 NULL、并把只为这个板块接的研招网源停用。
 * 旧地址**不做重定向**（与 2026-10-04 删板块那一层同一口径：为一个已经判定不要的功能留一张永久映射表不值）。
 */
export const CATEGORIES = [
  { key: "physical", label: "自然地理", section: "学科", guide: "地貌、气候、水文、土壤、植被等自然要素本身的变化，以及地震、火山、台风、洪涝干旱、冰川冻土、海平面与生态事件，要有观测数据、图件或影像支撑。卫星与软件本身归「地理信息系统」，区划与规划归「人文地理」" },
  { key: "human", label: "人文地理", section: "学科", guide: "人口与迁移、城市化、产业与交通区位、行政区划调整、城乡与区域政策等人类活动的空间格局，落点在人地关系。景区宣传、研学招生、旅游与教研营销软文不属于这里，研究生招生政策与招考数据也不属于这里（本站没有招考类别，这类材料走标签「非地理/通用」）" },
  { key: "regional", label: "区域地理", section: "学科", guide: "以具体区域或流域为单位的整体性变化：极地、青藏高原、黄土高原、三角洲、城市群、跨境河流等，重跨要素综合与尺度对比。单要素的单点事件按自然或人文归类" },
  { key: "geopolitics", label: "政治地理", section: "学科", guide: "主权、边界与领土的划定和争议，地缘格局、战略通道与能源路径，跨境河流、海洋权益与制裁封锁的空间含义，落点是权力与空间的关系。国内的区划调整与区域政策归「人文地理」；没有地点、尺度或空间格局的外交表态与时政评论不属于这里" },
  { key: "histgeo", label: "历史地理", section: "学科", guide: "历史时期的地理变迁与古今对照：河道与海岸线摆动、政区与疆域沿革、城址与聚落兴废、古道与贸易网络的迁移、古地图与地名考证，须同时有年代依据和地点依据。只有人物与年代、没有空间变化的史话掌故不属于这里；当下发生的区划与聚落变化归「人文地理」" },
  { key: "geotech", label: "地理信息系统", section: "技术", guide: "遥感卫星与影像、导航定位、观测数据集与标准的发布与版本变化，以及 GIS 软件与平台（ArcGIS、SuperMap、QGIS、天地图等）、空间数据库与数据标准、WebGIS 与三维引擎、开源生态与许可变更、空间分析功能的版本与工程应用——回答“地理信息怎么获得、怎么计算、系统怎么换代”。2026-10-03 按站长要求把原来的「地理信息技术」与「地理信息系统」两个分类并成一个区域（key 保留 `geotech`，网址与库里的身份不动）。用这些技术与系统得出的地学结论归对应学科类别" },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
/**
 * 防灾避险口径：这些类别或标签的条目，要在正文里给「本站不是预警信息发布机构」的安全提示留一个入口。
 * 判定规则属于行业，不属于页面——换行业时改这里，不改 `routes/item.tsx`。
 */
export const RISK_NOTICE_CATEGORIES: string[] = ["physical"];
export const RISK_NOTICE_TAGS: string[] = ["预警/响应", "灾害事件"];

/** 日报的「发布数量」指标统计这一类（数据与观测发布）。key 是稳定身份，节名跟着词表走。 */
export const RELEASE_CATEGORY_KEY = "geotech";

export const ITEM_TYPES = ["disaster_event", "observation_release", "policy_planning", "research_finding", "technology_release", "exploration_report", "opinion_analysis"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/**
 * 每篇资料的第一个标签必须是这些“分类标签”之一（最后一个“其他”是兜底，顺序不要动：vocabulary.ts:24 取它作默认值）。
 * 「非地理/通用」是预筛放行后的挡箭牌标签：它**不建主题页**（topics.json 里没有任何主题用它做匹配），
 * 只用来把教育文旅软文、招生与课件推销这类「过了预筛但不该进任何一个地理主题」的材料隔离在归类之外。
 * 2026-10-09 删掉「考研」类别之后，这一条隔离带**接管了全部招生口径**：专业目录、学科设置、大纲分数线、
 * 招考数据不再是正牌类别（TAG_SYNONYMS 里 招生/培训/课件 一直归「非地理/通用」，那一层从来没动过）。
 */
export const CATEGORY_TAGS = [
  "灾害事件", "预警/响应", "观测/数据发布", "研究/发现", "政策/规划", "技术与软件", "考察/记录", "地图与图集",
  "科普/教程", "评论/解读", "机构/动态", "非地理/通用", "其他",
] as const;

/**
 * 可选的主题标签：自然与灾害（12）、自然要素（5）、人文与区域（10）、技术与数据（4）。
 * 标签能不能进主题页取决于语料是否**产出**它：产出途径只有两条——模型/编辑逐字写出这个写法，
 * 或写出 TAG_SYNONYMS 里指向它的某个说法。所以新增主题标签时必须同时补上正文里真实出现的说法
 * （地貌类见“高原/平原”两行、灾害类见“海啸与风暴潮”行、人文类见“城市地理/经济地理”行），否则标签是死的、主题页永远空着。
 * 删标签前先数 topics.json：本站 31 个主题标签**每一个**都被至少一个主题页逐字引用（实测没有主题的标签=0 个），
 * 少一个就等于把那个主题页的入口拆掉一块（如 geopolitics 只有 政治地理/能源与资源/行政区划调整 三个标签）。
 * 2026-10 实测：`海啸与风暴潮、高原、平原、城市地理、经济地理、政治地理` 六个标签在 tooling/fixtures 的 562 个标签槽里产出 0 次，
 * 但它们是**语料缺口不是词表缺口**——近义词通路已开（青藏高原/黄土高原→高原、关中平原→平原、大中城市→城市地理、贸易网络/县域经济→经济地理、
 * 边境/主权→政治地理、tsunami/"storm surge"→海啸与风暴潮），而策划材料里确实有这些正文（science-L11 黄土高原与关中平原、china-L17 青藏高原冰湖、
 * china-L19 与 fill-stats-* 的 70 个大中城市/固定资产投资、fieldwork-L12 原油贸易网络、corpus-fieldwork 中尼边境、
 * fill-carbonbrief-sea-level-explainer 正文 “strengthen dangerous storm surges”；《地理研究》自己的栏目名就是 自然地理栏/乡村地理栏/演化经济地理栏）。
 * 缺的是有人把这些写法写进 fixture 的 tags，不是词表少了一格。反过来，正文里 0 次的说法（三角洲、冲积扇、划界）不开键，免得造出更死的格子。
 */
export const TOPIC_TAGS = [
  "地震", "火山", "地质灾害", "台风与寒潮", "海啸与风暴潮", "洪水与干旱", "冰川与冻土", "气候异常", "海平面", "地貌", "水资源", "生态与保护",
  "高原", "平原", "海洋", "植被", "土壤",
  "城市化", "人口迁移", "产业区位", "交通地理", "行政区划调整", "能源与资源", "城市地理", "乡村地理", "经济地理", "政治地理",
  "遥感影像", "卫星导航", "GIS与空间数据", "地图与制图",
] as const;

/**
 * 可选的实体标签（机构、部门、计划），与下面 ENTITIES 的 displayTag **按顺序**一一对应
 * （displayTag 为 null 的主体不入标签表，只用 entity:<id> 归类）：校验脚本与 tests 都逐字对拍这两个序列，
 * 给 ENTITIES 加一个非 null displayTag 就必须在这里同位置加同一个写法。
 * 拉丁字母的写法（USGS/NOAA/NASA/JAXA/GDACS/IPCC/OpenStreetMap）另外都要在 TAG_SYNONYMS 里有一个**小写**键：
 * vocabulary.ts:19 只对近义词表做 `t.toLowerCase()` 一次兜底，没有那个小写键时模型写成 Usgs/usgs 都归不回 USGS
 * （逐字写对才活得下来）；tests/industry-vocabulary.test.ts 的“近义词表不遮蔽正牌标签 + 每条都归一成功”两条断言盯着这张表。
 */
export const ENTITY_TAGS = ["中国地震台网", "USGS", "中国气象局", "NOAA", "NASA", "欧空局", "哥白尼计划", "JAXA", "中国科学院", "自然资源部", "应急管理部", "民政部", "世界气象组织", "联合国粮农组织", "GDACS", "IPCC", "国家统计局", "水利部", "OpenStreetMap"] as const;

/** 模型常写的近义词，统一成词表里的写法（值必须逐字等于词表里的标签）。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  灾情: "灾害事件", 灾害: "灾害事件", 突发事件: "灾害事件", 灾害风险: "灾害事件", 风险评估: "灾害事件", 灾情通报: "灾害事件", disaster: "灾害事件",
  预警: "预警/响应", 应急响应: "预警/响应", 响应级别: "预警/响应", 启动响应: "预警/响应", 红色预警: "预警/响应", alert: "预警/响应", warning: "预警/响应",
  数据发布: "观测/数据发布", 观测数据: "观测/数据发布", 公报: "观测/数据发布", 年报: "观测/数据发布", 白皮书: "观测/数据发布", 速报: "观测/数据发布", dataset: "观测/数据发布",
  论文: "研究/发现", 研究: "研究/发现", 科研: "研究/发现", 科学发现: "研究/发现", 研究论文: "研究/发现", 调查报告: "研究/发现", paper: "研究/发现", research: "研究/发现",
  政策: "政策/规划", 规划: "政策/规划", 国土空间规划: "政策/规划", 审批: "政策/规划", 法规: "政策/规划", policy: "政策/规划",
  技术: "技术与软件", 软件: "技术与软件", 版本更新: "技术与软件", 平台上线: "技术与软件", 系统发布: "技术与软件", release: "技术与软件",
  考察: "考察/记录", 科考: "考察/记录", 野外调查: "考察/记录", 航次: "考察/记录", 剖面: "考察/记录", 田野调查: "考察/记录", expedition: "考察/记录",
  地图: "地图与图集", 图集: "地图与图集", 专题图: "地图与图集", 制图成果: "地图与图集", 数据产品: "地图与图集",
  科普: "科普/教程", 教程: "科普/教程", 指南: "科普/教程", 实践: "科普/教程", 方法: "科普/教程", 最佳实践: "科普/教程", tutorial: "科普/教程",
  评论: "评论/解读", 观点: "评论/解读", 解读: "评论/解读", 分析: "评论/解读", 社论: "评论/解读", 访谈: "评论/解读", opinion: "评论/解读",
  机构: "机构/动态", 动态: "机构/动态", 会议: "机构/动态", 合作: "机构/动态", 人事: "机构/动态", 预算: "机构/动态",
  非地理: "非地理/通用", 旅游: "非地理/通用", 研学: "非地理/通用", 招生: "非地理/通用", 培训: "非地理/通用", 课件: "非地理/通用", 软文: "非地理/通用", 景区宣传: "非地理/通用",
  文旅: "非地理/通用", 景区: "非地理/通用", 旅游推广: "非地理/通用", 旅游线路: "非地理/通用",
  // 模型常把类别名和提示词里的类型名当标签写，统一回词表。
  观测与数据发布: "观测/数据发布", 政策与规划: "政策/规划", 区划规划与政策: "政策/规划", 研究与科学发现: "研究/发现", 考察与发现记: "考察/记录",
  地理信息技术: "技术与软件", 野外考察: "考察/记录", 科学考察: "考察/记录", 天气与气候: "气候异常", 天气: "气候异常",
  震情: "地震", 震群: "地震", 余震: "地震", 强震: "地震", 地震活动: "地震", earthquake: "地震",
  火山喷发: "火山", 喷发: "火山", 火山灰: "火山", 火山口: "火山", eruption: "火山",
  滑坡: "地质灾害", 泥石流: "地质灾害", 崩塌: "地质灾害", 地面沉降: "地质灾害", 塌陷: "地质灾害", landslide: "地质灾害",
  台风: "台风与寒潮", 飓风: "台风与寒潮", 寒潮: "台风与寒潮", 热带气旋: "台风与寒潮", 冷空气: "台风与寒潮", 暴风雪: "台风与寒潮", typhoon: "台风与寒潮", hurricane: "台风与寒潮",
  // 语料里这个概念只有英文材料带出来（json-usgs-quake-m45 正文“tsunami flag 0”、rss-nature-geoscience“extreme tsunami hazards”、
  // rss-gdacs-alerts“Red notification for tropical cyclone POLO-26”），中文说法“海啸风险/风暴潮预警”是模型对这些材料的自然写法，一并补上。
  // surge 单独不开键：这批语料里唯一的 surge 是“Forest loss surged”那个动词，不是增水（corpus-fieldwork/curated-materials 实测）。
  海啸: "海啸与风暴潮", 风暴潮: "海啸与风暴潮", 海啸预警: "海啸与风暴潮", 海啸警报: "海啸与风暴潮", 海啸风险: "海啸与风暴潮", 风暴潮预警: "海啸与风暴潮", 台风风暴潮: "海啸与风暴潮", 天文大潮: "海啸与风暴潮", 海岸增水: "海啸与风暴潮", tsunami: "海啸与风暴潮", "storm surge": "海啸与风暴潮", storm: "海啸与风暴潮",
  洪水: "洪水与干旱", 洪涝: "洪水与干旱", 干旱: "洪水与干旱", 内涝: "洪水与干旱", 汛情: "洪水与干旱", 水旱灾害: "洪水与干旱", flood: "洪水与干旱", drought: "洪水与干旱",
  冰川: "冰川与冻土", 冻土: "冰川与冻土", 融冰: "冰川与冻土", 冰盖: "冰川与冻土", 积雪: "冰川与冻土", 冰架: "冰川与冻土", permafrost: "冰川与冻土", glacier: "冰川与冻土",
  气候: "气候异常", 变暖: "气候异常", 气候变化: "气候异常", 极端天气: "气候异常", 厄尔尼诺: "气候异常", 拉尼娜: "气候异常", climate: "气候异常",
  海平面上升: "海平面", 海水入侵: "海平面", 海岸侵蚀: "海平面",
  地形: "地貌", 侵蚀: "地貌", 地表形态: "地貌", 山脉: "地貌", 河谷: "地貌", 丘陵: "地貌", 山地: "地貌", 盆地: "地貌", 喀斯特: "地貌", 构造运动: "地貌",
  // 正文只会写具体高原/平原的名字，不会单写「高原」「平原」这两个类名，只能靠下面这批地貌专名把标签带出来（实测语料 高原 41 次、平原 6 次，全在专名里）。
  // 有材料依据：水利部「李国英赴西藏调研冰湖监测预警及风险防范工作」正文“青藏高原冰湖分布广”（corpus-china china-L17）；《地理研究》「乡村人口收缩与耕地规模化转型——以陕西省为例」正文“陕北黄土高原区北部”“主要位于关中平原内部”（science-L11）；「黄土区坡面水土保持措施对流域水沙关系的影响」。
  // 其余四条（云贵/内蒙古高原、华北/长江中下游平原、冲积平原）是同一批地貌专名，语料里出现的是同一句式，一并收进这张表以免只补一半。三角洲、冲积扇在这批语料里 0 次，不开键。
  青藏高原: "高原", 黄土高原: "高原", 云贵高原: "高原", 内蒙古高原: "高原", 黄土区: "高原", 高原区: "高原", plateau: "高原",
  关中平原: "平原", 华北平原: "平原", 长江中下游平原: "平原", 冲积平原: "平原", plain: "平原",
  河流: "水资源", 湖泊: "水资源", 地下水: "水资源", 径流: "水资源", 水资源短缺: "水资源", watershed: "水资源",
  海洋与海岸: "海洋", 海岸: "海洋", 海岸带: "海洋", 海域: "海洋", 洋流: "海洋", 海温: "海洋", 北极: "海洋", 南极: "海洋", 海冰: "海洋", ocean: "海洋",
  植被覆盖: "植被", 森林: "植被", 草原: "植被", 草地: "植被", 灌木: "植被", 物候: "植被", vegetation: "植被",
  土壤侵蚀: "土壤", 水土流失: "土壤", 土地退化: "土壤", 黑土: "土壤", 土地整治: "土壤", soil: "土壤",
  生态: "生态与保护", 保护区: "生态与保护", 生物多样性: "生态与保护", 湿地: "生态与保护", 荒漠化: "生态与保护", ecosystem: "生态与保护",
  城镇化: "城市化", 城市扩张: "城市化", 城市群: "城市化", 都市圈: "城市化", 城市增长: "城市化", urbanization: "城市化",
  // 「大中城市」有材料依据：国家统计局「2026年8月份70个大中城市商品住宅销售价格变动情况」（web-stats-latest，正文全是分城市指数表）。
  城市体系: "城市地理", 城市规模: "城市地理", 城市形态: "城市地理", 大城市: "城市地理", 大中城市: "城市地理", 城市空间: "城市地理", 都市: "城市地理",
  乡村: "乡村地理", 农村: "乡村地理", 村庄: "乡村地理", 乡村振兴: "乡村地理", 县域: "乡村地理",
  // 「贸易网络/供应链/经济韧性」有材料依据：《地理研究》「全球供应链中断情景下中国原油贸易网络的韧性研究」（正文“供应链中断”“原油贸易网络”“韧性”，标题本身归经济地理）。
  // 「县域经济」有材料依据：澎湃新闻「县域经济你追我赶…持续释放经济发展活力」策划（corpus-china，12 次）——它和单写「县域」（归乡村地理）不是同一件事，所以单独开键。
  // 《地理研究》自己的栏目名就是「演化经济地理栏」，经济地理是这门学科自己的说法，不是我们生造的格子。
  经济格局: "经济地理", 区域经济: "经济地理", 经济带: "经济地理", 产业转移: "经济地理", 贸易网络: "经济地理", 供应链: "经济地理", 经济韧性: "经济地理", 经济: "经济地理", 贸易: "经济地理", 县域经济: "经济地理",
  // 政治地理的近义词已经覆盖地缘/边界/领土一类写法；「边境」「主权」都有正文依据（corpus-fieldwork「尼泊尔喜马拉雅边境区岩冰崩」、
  // corpus-fill fill-grist-un-sea-level-declaration「巴哈马陆地不足海拔 3 米，主权如何延续」）。但地缘/领土/划界在这 350 条语料正文里一次都没出现，所以这个标签空着是
  // **语料缺口**（要的是信源与策划材料：边界谈判、海域划界、跨境河流协议），不是词表缺口——topics.json 里
  // geopolitics/administrative-divisions/arid-west-asia-north-africa/energy-resources 四个主题页都拿它当入口（2026-10-08 数出来的；
  // 这里以前还列着第五个 opinion-analysis，topics.json 里没有这个主题，是一个不存在的入口被当成了改词表的理由）。
  地缘: "政治地理", 地缘政治: "政治地理", 边界: "政治地理", 国界: "政治地理", 边境: "政治地理", 领土: "政治地理", 主权: "政治地理", 政治: "政治地理", geopolitics: "政治地理",
  移民: "人口迁移", 人口流动: "人口迁移", 人口变化: "人口迁移", 户籍迁移: "人口迁移", migration: "人口迁移",
  产业布局: "产业区位", 工业区位: "产业区位", 产业链: "产业区位", 资源型城市: "产业区位",
  交通: "交通地理", 高铁: "交通地理", 港口: "交通地理", 机场: "交通地理", 物流通道: "交通地理",
  区划调整: "行政区划调整", 行政区划: "行政区划调整", 设市: "行政区划调整", 撤县设区: "行政区划调整", 撤地设市: "行政区划调整",
  矿产: "能源与资源", 油气: "能源与资源", 新能源: "能源与资源", 战略资源: "能源与资源", 能源安全: "能源与资源",
  遥感: "遥感影像", 卫星影像: "遥感影像", 对地观测: "遥感影像", 影像数据: "遥感影像", remote: "遥感影像", sensing: "遥感影像",
  北斗: "卫星导航", 导航定位: "卫星导航", 定位系统: "卫星导航", 授时: "卫星导航", gnss: "卫星导航", gps: "卫星导航",
  空间数据: "GIS与空间数据", 空间分析: "GIS与空间数据", 地理信息: "GIS与空间数据", 开源gis: "GIS与空间数据", gis: "GIS与空间数据",
  制图: "地图与制图", 地图集: "地图与制图", 三维地图: "地图与制图", 数字孪生地球: "地图与制图",
  中国地震台网中心: "中国地震台网", 地震台网: "中国地震台网", 台网中心: "中国地震台网", cenc: "中国地震台网",
  美国地质调查局: "USGS", usgs: "USGS",
  // ⚠ 有意为之的**父子归并**（不是形似碰撞）：中央气象台＝国家气象中心，是中国气象局直属事业单位；
  // 国家气象局／中央气象台在本站词表里合成一格，读者可见的实体标签只有「中国气象局」这一格（ENTITY_TAGS 没有「中央气象台」）。
  // 后果要如实写清：**凡原文只写「中央气象台」「国家气象中心」的条目，摘要与标题被允许写上级机构名「中国气象局」**，
  // 反向同理（写「中国气象局发布」而原文是县气象台的不算张冠李戴）。这一格与下面「应急部／国家防总」那格是同一类决定，
  // 理由、代价与要拆开需要同时改的地方都写在 ENTITIES.cma 与 IDENTITY_LEXICON 的 cma 条目注释里；
  // tests/industry-vocabulary.test.ts 有一条哨兵盯着这个合并，拆的时候必须同时改那张表。
  // 「气象局」单独成键是为了省写法（河北省气象局→中国气象局那格是**标签口径**，不是身份声明：
  // structure 的 subjects 由人写定，这批省级预警语料的 subjects 一律留空，见 corpus-hazards-brain 的 structure-alarm-nmc-*）。
  气象局: "中国气象局", 中央气象台: "中国气象局", 国家气象中心: "中国气象局", cma: "中国气象局", nmc: "中国气象局",
  美国国家海洋和大气管理局: "NOAA", 国家飓风中心: "NOAA", noaa: "NOAA", nhc: "NOAA",
  美国宇航局: "NASA", 美国国家航空航天局: "NASA", nasa: "NASA",
  欧洲空间局: "欧空局", esa: "欧空局",
  哥白尼: "哥白尼计划", 哨兵卫星: "哥白尼计划", copernicus: "哥白尼计划", sentinel: "哥白尼计划",
  日本宇宙航空研究开发机构: "JAXA", jaxa: "JAXA",
  中科院: "中国科学院", 地理资源所: "中国科学院", 中国科学院地理科学与资源研究所: "中国科学院",
  国土部: "自然资源部", 国家地理信息中心: "自然资源部",
  // 同为**父子/归口合并**（见上面 cma 那段的说明）：国家防总＝国家防汛抗旱总指挥部，其办公室设在应急管理部，
  // 本站把它归到「应急管理部」这一格，摘要因此可以写上级口径；这不是拼写形似，是组织关系。
  应急部: "应急管理部", 国家防总: "应急管理部", 国家防汛抗旱总指挥部: "应急管理部",
  区划地名: "民政部",
  // 水利部是 T1 信源 web-mwr-news / web-mwr-data 的发布方（“赣江发生2026年第1号洪水”“乡村振兴水利保障工作简报”），标签必须落得下来。
  // 正文里它对外的三种写法都在用：全称（中华人民共和国水利部）、简称（水利部，就是 displayTag 本身）、下属口径（水利部门/水利部办公厅）。
  中华人民共和国水利部: "水利部", 水文水资源: "水利部", 河长制: "水利部", 全国水雨情: "水利部", 水利部办公厅: "水利部", 水利部门: "水利部", 水资源公报: "水利部", mwr: "水利部",
  // 国家统计局是 T1 信源 web-stats-latest 的发布方；sources.json 里它的 owner_entity_id 写法是 nbs，所以这个大小写两种拼法都要能归一。
  中华人民共和国国家统计局: "国家统计局", 统计局: "国家统计局", 人口普查公报: "国家统计局", 统计公报: "国家统计局", 经济普查: "国家统计局", nbs: "国家统计局",
  气候变化专门委员会: "IPCC", 政府间气候变化专门委员会: "IPCC", 联合国政府间气候变化专门委员会: "IPCC", 气候专门委员会: "IPCC", "intergovernmental panel on climate change": "IPCC", ar6: "IPCC", ipcc: "IPCC",
  气象组织: "世界气象组织", 世界天气监视网: "世界气象组织", "world meteorological organization": "世界气象组织", wmo: "世界气象组织",
  粮农组织: "联合国粮农组织", 全球农业灾害: "联合国粮农组织", 联合国粮食及农业组织: "联合国粮农组织", "food and agriculture organization": "联合国粮农组织", fao: "联合国粮农组织",
  全球灾害预警与协调系统: "GDACS", 联合国灾害评估: "GDACS", "global disaster alert and coordination system": "GDACS", gdacs: "GDACS",
  // openstreetmap 是必须有的小写键：vocabulary.ts:19 只对近义词表做 t.toLowerCase() 兜底，正牌写法 OpenStreetMap 大小写不敏感要靠这个键。
  开源地图: "OpenStreetMap", 开放街图: "OpenStreetMap", osm: "OpenStreetMap", openstreetmap: "OpenStreetMap", overpass: "OpenStreetMap",
};

/** 模型漏了分类标签时，按内容类型补一个（值必须是 CATEGORY_TAGS 里的写法：它会成为第一个标签）。 */
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  disaster_event: "灾害事件", observation_release: "观测/数据发布", policy_planning: "政策/规划", research_finding: "研究/发现",
  technology_release: "技术与软件", exploration_report: "考察/记录", opinion_analysis: "评论/解读",
};

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/** 机构主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  cenc: { name: "中国地震台网中心", displayTag: "中国地震台网", aliases: ["中国地震台网中心", "中国地震台网", "CENC", "地震速报"] },
  usgs: { name: "美国地质调查局 USGS", displayTag: "USGS", aliases: ["USGS", "美国地质调查局", "ShakeAlert"] },
  // aliases 里的「中央气象台」「国家气象中心」是有意的父子归并（上级名可代下级名），不是别名表写松了；详见 TAG_SYNONYMS 里 cma 那一段的注释。
  cma: { name: "中国气象局", displayTag: "中国气象局", aliases: ["中国气象局", "CMA", "中央气象台", "国家气象中心"] },
  noaa: { name: "NOAA", displayTag: "NOAA", aliases: ["NOAA", "美国国家海洋和大气管理局", "国家飓风中心", "NHC"] },
  nasa: { name: "NASA", displayTag: "NASA", aliases: ["NASA", "美国宇航局", "JPL", "Landsat"] },
  esa: { name: "欧洲空间局 ESA", displayTag: "欧空局", aliases: ["ESA", "欧空局", "欧洲空间局"] },
  copernicus: { name: "哥白尼计划", displayTag: "哥白尼计划", aliases: ["Copernicus", "哥白尼", "Sentinel", "哨兵卫星"] },
  jaxa: { name: "JAXA", displayTag: "JAXA", aliases: ["JAXA", "日本宇宙航空研究开发机构", "ALOS"] },
  cas: { name: "中国科学院", displayTag: "中国科学院", aliases: ["中国科学院", "中科院", "中国科学院地理资源所"] },
  mnr: { name: "自然资源部", displayTag: "自然资源部", aliases: ["自然资源部", "国土部", "国家地理信息中心"] },
  // 同上：国家防总归口应急管理部，aliases 里的这一项是有意的父子归并。
  mem: { name: "应急管理部", displayTag: "应急管理部", aliases: ["应急管理部", "应急部", "国家防总"] },
  mca: { name: "民政部", displayTag: "民政部", aliases: ["民政部", "区划地名司"] },
  wmo: { name: "世界气象组织 WMO", displayTag: "世界气象组织", aliases: ["世界气象组织", "WMO", "World Meteorological Organization", "世界天气监视网", "联合国世界气象组织"] },
  fao: { name: "联合国粮农组织 FAO", displayTag: "联合国粮农组织", aliases: ["联合国粮农组织", "粮农组织", "FAO", "Food and Agriculture Organization", "全球农业灾害"] },
  gdacs: { name: "GDACS 全球灾害预警与协调系统", displayTag: "GDACS", aliases: ["GDACS", "全球灾害预警与协调系统", "Global Disaster Alert and Coordination System", "联合国灾害评估"] },
  ipcc: { name: "IPCC", displayTag: "IPCC", aliases: ["IPCC", "政府间气候变化专门委员会", "联合国政府间气候变化专门委员会", "Intergovernmental Panel on Climate Change", "AR6"] },
  stats: { name: "国家统计局", displayTag: "国家统计局", aliases: ["国家统计局", "中华人民共和国国家统计局", "NBS", "National Bureau of Statistics", "统计公报"] },
  mwr: { name: "水利部", displayTag: "水利部", aliases: ["水利部", "中华人民共和国水利部", "水利部办公厅", "MWR", "Ministry of Water Resources"] },
  undrr: { name: "联合国减灾办公室", displayTag: null, aliases: ["UNDRR", "联合国减灾办公室", "国际减灾战略"] },
  soa: { name: "国家海洋局", displayTag: null, aliases: ["国家海洋局", "海洋预报台", "国家海洋环境预报中心"] },
  osm: { name: "OpenStreetMap", displayTag: "OpenStreetMap", aliases: ["OpenStreetMap", "OSM", "Overpass API", "开放街图"] },
  // 以下 11 个是 PUBLISHER_DOMAINS 里的发布域主人：它们进 ENTITIES 只为了让「域名 → 主体」这条链在代码里闭合
  // （packages/backend/src/editorial/writing.ts:154 取到的 entityId 必须能在名录里查到），displayTag 一律 null：
  // displayTag 非 null 就等于给读者可见的实体白名单加一格（ENTITY_TAGS 与 content-understanding.md 要同步改），
  // 而这一批既没有主题页（industry/topics.json 的 10 个机构主题不含它们），也填不满 6 个标签的额度，加进去只会稀释词表。
  cea: { name: "中国地震局", displayTag: null, aliases: ["中国地震局", "China Earthquake Administration", "CEA"] },
  emsc: { name: "欧洲-地中海地震中心", displayTag: null, aliases: ["EMSC", "欧洲-地中海地震中心", "European-Mediterranean Seismological Centre"] },
  cnes: { name: "法国国家空间研究中心", displayTag: null, aliases: ["CNES", "法国国家空间研究中心", "Centre national d'études spatiales"] },
  dlr: { name: "德国航空航天中心", displayTag: null, aliases: ["DLR", "德国航空航天中心", "German Aerospace Center"] },
  cgs: { name: "中国地质调查局", displayTag: null, aliases: ["中国地质调查局", "地调局", "China Geological Survey", "CGS"] },
  ndrc: { name: "国家发展改革委", displayTag: null, aliases: ["国家发展改革委", "发改委", "National Development and Reform Commission"] },
  mee: { name: "生态环境部", displayTag: null, aliases: ["生态环境部", "中华人民共和国生态环境部", "Ministry of Ecology and Environment"] },
  forestry: { name: "国家林草局", displayTag: null, aliases: ["国家林草局", "国家林业和草原局", "National Forestry and Grassland Administration"] },
  esri: { name: "Esri / ArcGIS", displayTag: null, aliases: ["Esri", "ArcGIS", "Environmental Systems Research Institute"] },
  supermap: { name: "超图软件", displayTag: null, aliases: ["超图", "超图软件", "SuperMap"] },
  maxar: { name: "Maxar", displayTag: null, aliases: ["Maxar", "Maxar Technologies", "WorldView"] },
};

/**
 * 身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 行业没有这个问题时可以留空数组。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "cenc", name: "中国地震台网中心", patterns: [/中国地震台网|台网中心|\bcenc\b/i] },
  { id: "usgs", name: "美国地质调查局 USGS", patterns: [/\busgs\b|美国地质调查局|shakealert|\blandsat\b/i] },
  { id: "cea", name: "中国地震局", patterns: [/中国地震局/i] },
  { id: "emsc", name: "欧洲-地中海地震中心", patterns: [/\bemsc\b|欧洲地中海地震/i] },
  { id: "geofon", name: "德国地学中心 GFZ", patterns: [/\bgfz\b|德国地学中心|geofon/i] },
  // 这一格是**父子归并**，不是词典写宽了：中央气象台＝国家气象中心＝中国气象局直属事业单位，本站把三个写法收进同一个 id。
  // 守卫的实际后果（写清楚，别让它当秘密）：原文只写「中央气象台」的条目，标题与摘要允许写上级名「中国气象局」，反向也一样。
  // 本轮（2026-10-02）评估过给 NMC 单列 id 的方案，判定**不改**，理由三条，都在报告里：
  // ① 只拆这一格拦不住事发的那批条目——json-nmc-weather-alarm 的 owner_entity_id 是 cma、PUBLISHER_DOMAINS 又把 nmc.cn 判给 cma，
  //    而 writing.ts:195-196 是拿 publisher+owner 直接加进放行集合的，与原文用词无关；要真拦住得把域与 owner 一起搬到新的 nmc 实体。
  // ② 搬到新实体要付两笔账：机构主题页按 entity:<id> 收条目（topics.json 的中国气象局主题会漏掉改判后的条目），
  //    而守卫失配时是**整条摘要丢弃**（writing.ts:224），本站已经因为同类"会删掉忠实内容的校验器"撤下过综述溯源器（docs/known-issues.md）。
  // ③ 上级名代下级名是"精度不够"，不是"无中生有"，与这道守卫要防的两个不相关机构张冠李戴（见 tests/identity-guard.test.ts 钉住的
  //    地质调查局碰撞）不是同一类缺陷。要拆的话：ENTITIES 加 nmc（displayTag 仍 null）、IDENTITY_LEXICON 拆两行并把 cma 的 name 改回
  //    「中国气象局」（否则 tests/identity-guard.test.ts:108 那条 collision 断言会变红）、PUBLISHER_DOMAINS 把 nmc.cn 改判 nmc、
  //    sources.json 的 owner_entity_id 同步，并让 tests/industry-vocabulary.test.ts 那条哨兵断言一起改。
  { id: "cma", name: "中国气象局 / 中央气象台", patterns: [/中国气象局|中央气象台|国家气象中心|\bnmc\b|\bcma\b/i] },
  { id: "nsmc", name: "国家卫星气象中心（风云卫星）", patterns: [/国家卫星气象中心|\bnsmc\b|风云卫星|风云[一二三四五六七八九十\d]/i] },
  { id: "jma", name: "日本气象厅", patterns: [/日本气象厅|\bjma\b/i] },
  { id: "metoffice", name: "英国气象局 Met Office", patterns: [/met office|英国气象局/i] },
  { id: "ecmwf", name: "欧洲中期天气预报中心", patterns: [/ecmwf|欧洲中期天气预报中心|\bera5\b/i] },
  { id: "noaa", name: "NOAA", patterns: [/\bnoaa\b|国家海洋和大气管理局|国家飓风中心|\bnhc\b|飓风中心|海啸预警中心|\bptwc\b|\bntwc\b/i] },
  { id: "soa", name: "国家海洋局 / 海洋预报台", patterns: [/国家海洋局|海洋预报台|海洋环境预报|风暴潮|海啸警报/i] },
  { id: "nasa", name: "NASA", patterns: [/\bnasa\b|美国宇航局|美国国家航空航天局|\bjpl\b|喷气推进实验室|\bmodis\b|\bviirs\b|\blandsat\b|icesat/i] },
  { id: "esa", name: "欧洲空间局 ESA", patterns: [/\besa\b|欧空局|欧洲空间局|european space agency/i] },
  { id: "copernicus", name: "哥白尼计划", patterns: [/copernicus|哥白尼|sentinel[\s-]?\d|哨兵卫星/i] },
  { id: "jaxa", name: "JAXA", patterns: [/\bjaxa\b|日本宇宙航空研究开发机构|\balos\b/i] },
  { id: "cnes", name: "法国国家空间研究中心", patterns: [/\bcnes\b|法国国家空间研究中心/i] },
  { id: "dlr", name: "德国航空航天中心", patterns: [/\bdlr\b|德国航空航天中心|tandem[-\s]?x|terrasar/i] },
  { id: "isro", name: "印度空间研究组织", patterns: [/\bisro\b|印度空间研究组织/i] },
  { id: "cas", name: "中国科学院", patterns: [/中国科学院|中科院/i] },
  { id: "qtp", name: "青藏高原综合科学考察", patterns: [/青藏科考|青藏高原研究|第二次青藏|青藏所|地球三期/i] },
  { id: "polar", name: "中国极地研究中心", patterns: [/极地研究中心|雪龙|中国南极考察|中国北极考察|中山站|昆仑站|泰山站|黄河站|长城站/i] },
  { id: "mnr", name: "自然资源部", patterns: [/自然资源部|国土变更调查|地理国情监测|国土调查/i] },
  { id: "cgs", name: "中国地质调查局", patterns: [/地质调查局|中国地质调查|\bcgs\b/i] },
  // 与 cma 那格同类：国家防总（国家防汛抗旱总指挥部）归口应急管理部，属**有意的父子/归口合并**，摘要允许写上级机构名。
  { id: "mem", name: "应急管理部", patterns: [/应急管理部|国家防汛抗旱总指挥部|国家防总|应急救援|安全生产/i] },
  { id: "mwr", name: "水利部", patterns: [/水利部|水文水资源|河长制|水利普查/i] },
  { id: "mca", name: "民政部", patterns: [/民政部|行政区划管理|地名普查/i] },
  { id: "ndrc", name: "国家发展改革委", patterns: [/发改委|国家发展改革委|国家发展和改革委|\bndrc\b/i] },
  { id: "mee", name: "生态环境部", patterns: [/生态环境部|生态保护红线|生态环境保护督察/i] },
  { id: "forestry", name: "国家林草局", patterns: [/林草局|林业和草原|自然保护地|国家公园管理局/i] },
  { id: "stats", name: "国家统计局", patterns: [/国家统计局|人口普查公报|经济普查|统计公报/i] },
  { id: "undrr", name: "联合国减灾办公室", patterns: [/undrr|联合国减灾|国际减灾战略|仙台框架/i] },
  { id: "gdacs", name: "GDACS 全球灾害预警与协调系统", patterns: [/\bgdacs\b|全球灾害预警与协调/i] },
  { id: "ipcc", name: "IPCC", patterns: [/ipcc|政府间气候变化专门委员会|气候评估报告|\bar6\b/i] },
  { id: "wmo", name: "世界气象组织", patterns: [/\bwmo\b|世界气象组织/i] },
  { id: "unhabitat", name: "联合国人居署", patterns: [/un[-\s]?habitat|人居署|世界城市化/i] },
  { id: "nsidc", name: "美国国家冰雪数据中心", patterns: [/\bnsidc\b|国家冰雪数据中心/i] },
  { id: "tianditu", name: "天地图", patterns: [/天地图|国家地理信息公共服务平台/i] },
  { id: "esri", name: "Esri / ArcGIS", patterns: [/\besri\b|arcgis/i] },
  { id: "supermap", name: "超图软件", patterns: [/supermap|超图/i] },
  { id: "osgeo", name: "QGIS / OSGeo", patterns: [/\bqgis\b|\bosgeo\b|geoserver|\bgdal\b/i] },
  { id: "maxar", name: "Maxar", patterns: [/\bmaxar\b|worldview[\s-]?\d/i] },
  { id: "planet", name: "Planet Labs", patterns: [/planet labs|\bskysat\b|planet[\s-]?dove/i] },
  { id: "osm", name: "OpenStreetMap", patterns: [/openstreetmap|\bosm\b|overpass api/i] },
  { id: "fao", name: "联合国粮农组织", patterns: [/\bfao\b|粮农组织|全球农业灾害/i] },
  { id: "amap", name: "高德地图", patterns: [/\bamap\b|高德地图/i] },
];

/**
 * 这些域名上的文章，发布方就是对应的机构（新闻与期刊网站不算，它们报道而不是发布）。
 * 不变量：entityId 必须同时存在于 ENTITIES 与 IDENTITY_LEXICON——writing.ts:154 用它做「文档发布域主体」，
 * 而这个名字要能在名录里查到才会进身份守卫的放行集合。tests/identity-guard.test.ts:84 只断言 ⊂ IDENTITY_LEXICON；
 * ⊂ ENTITIES 这条现在没有任何测试盯着（2026-10-01 实测：改前 29 条里有 11 条悬空，改后 0 条），要靠本文件的注释守住，
 * 或让 tests 负责人补一句 `assert.ok(entry.entityId in ENTITIES)`。
 * 2026-10-01 逐域 curl 过（跟随跳转、25 s 超时；条目记裸域，而 writing.ts:154 是按 `host.endsWith(domain)` 匹配的，
 * 所以应答的是 www.* 也算命中——多数 .gov.cn 裸域根本不应答）：29 条 / 33 个域里只有三个例外——
 * www.mwr.gov.cn 只有 http 回 200（https 握手超时，信源 web-mwr-* 就是它，保留）；supermap.com 两种协议都回 403
 * （反爬但域名活着，本站无超图信源，留着只补「域名→主体」这一格）；cma.cn 裸域 http/https 全不通，已换成实测 200 的 cma.gov.cn。
 * 另外补了三条本站真实信源在用、原来漏配的域：ceic.ac.cn（json-ceic-earthquake 的 T1 数据域，中国地震台网中心自己的站）、
 * gdacs.org（rss-gdacs-alerts）、openstreetmap.org（rss-osm-blog）。
 * 故意**不**补 dlyj.ac.cn（《地理研究》刊站，owner_entity_id 写的是 cagp，不在名录）：把刊站判给「中国科学院」会让身份守卫
 * 允许摘要写原文没写的机构名，那正是这道守卫要防的事。
 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "cenc", domains: ["cenc.ac.cn", "ceic.ac.cn"] },
  { entityId: "cea", domains: ["cea.gov.cn"] },
  { entityId: "usgs", domains: ["usgs.gov"] },
  { entityId: "emsc", domains: ["emsc-csem.org"] },
  { entityId: "cma", domains: ["nmc.cn", "cma.gov.cn"] },
  { entityId: "noaa", domains: ["noaa.gov", "weather.gov", "tsunami.gov"] },
  { entityId: "nasa", domains: ["nasa.gov"] },
  { entityId: "esa", domains: ["www.esa.int"] },
  { entityId: "copernicus", domains: ["copernicus.eu"] },
  { entityId: "jaxa", domains: ["jaxa.jp"] },
  { entityId: "cnes", domains: ["cnes.fr"] },
  { entityId: "dlr", domains: ["dlr.de"] },
  { entityId: "cas", domains: ["cas.cn"] },
  { entityId: "mnr", domains: ["mnr.gov.cn"] },
  { entityId: "cgs", domains: ["cgs.gov.cn"] },
  { entityId: "mem", domains: ["mem.gov.cn"] },
  { entityId: "mwr", domains: ["mwr.gov.cn"] },
  { entityId: "mca", domains: ["mca.gov.cn"] },
  { entityId: "ndrc", domains: ["ndrc.gov.cn"] },
  { entityId: "mee", domains: ["mee.gov.cn"] },
  { entityId: "forestry", domains: ["forestry.gov.cn"] },
  { entityId: "stats", domains: ["stats.gov.cn"] },
  { entityId: "ipcc", domains: ["ipcc.ch"] },
  { entityId: "wmo", domains: ["wmo.int"] },
  { entityId: "gdacs", domains: ["gdacs.org"] },
  { entityId: "osm", domains: ["openstreetmap.org"] },
  { entityId: "esri", domains: ["esri.com"] },
  { entityId: "supermap", domains: ["supermap.com"] },
  { entityId: "maxar", domains: ["maxar.com"] },
];

/** 原文里的这些写法也算提到了对应机构（词典的正则覆盖不到的拼法、账号与专名）。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "usgs", pattern: /earthquake\.usgs\.gov|@usgs\b|\busgs\.gov\b/i },
  { entityId: "noaa", pattern: /@noaa\b|@nhc_atlantic\b|@spchurricane\b|products\.noaa\.gov/i },
  { entityId: "copernicus", pattern: /哨兵[\s-]?(?:一号|二号|三号|四号|五号|六号|[1-6]p?)/ },
  { entityId: "soa", pattern: /国家海洋环境预报中心|海洋预警报|自然资源部海洋预警监测司/ },
];
