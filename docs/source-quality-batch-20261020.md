# 附件入口与发布主体最小修正

本批基于 `69757e7`，只更新 5 个既有 source 的 owner，并为 CEMADEN 过滤图像附件入口、纠正语言标签。来源地址、启停、轮询、分类及全文权限保持原值；启用数仍为 666。本地配置变更不代表生产已经同步。

| source id | owner | 官方依据 |
| --- | --- | --- |
| `br-cemaden-rss` | `cemaden` | [CEMADEN 官网](https://www.gov.br/cemaden/pt-br)的机构全称与风险预报栏目，2026-10-20 核对。 |
| `gt-esa-eo-news`、`eu-esa-copernicus-feed` | `esa` | [ESA RSS 指南](https://www.esa.int/Services/RSS_Feeds)提供免费栏目订阅；两个既有官方 feed 的冻结样本具有 ESA 域原文。 |
| `rss-uk-govuk-envagency` | `uk-environment-agency` | [英国环境署介绍](https://www.gov.uk/government/organisations/environment-agency)。 |
| `gb-govuk-defra-atom` | `uk-defra` | [Defra 介绍](https://www.gov.uk/government/organisations/department-for-environment-food-rural-affairs)。 |

补充的 3 个实体同时登记在 `ENTITIES` 与 `IDENTITY_LEXICON`，是 owner 参照完整性所必需；`displayTag=null`，不增加可见主题标签，也不将整个 `gov.uk` 域判给某一机构。环境署与 Defra 保持不同主体；同一原文的多频道发现不等于独立核证。免费订阅和机构归属均不自动授予全文转载许可。

CEMADEN 的正式 RSS 冻结样本同时提供预报父页面与 `20261019_hidro_t1.png/view`、`destaque.jpeg/view` 附件包装页。新增可选 `denyUrlFileExtensions` 为最多 32 个、各 1–12 位 ASCII 字母数字的扩展名数组，不带点、不接受正则。统一 URL 规则只检查最后文件段，允许一个结尾 `/view` 包装；查询参数不参与扩展名判定。只为 CEMADEN 配置 `png/jpg/jpeg/gif/webp/svg/ico`，保留 PDF、父文章及其他源行为。后台试抓、正常采集与新闻 RSS 回填复用同一过滤入口。

没有校准编辑标注的情况下，本批不实施许可广告、招聘、预算等标题否决词，也不修改 DHMZ 日期或夏令时策略。

既有站点同步需先部署受支持配置键，再读取每条来源当前完整配置及 `rN`，通过 `updateSource` 合并点名字段并记录审计理由；并发冲突重新审核，不绕过锁。`seed.ts` 对已有 source 使用 `ON CONFLICT DO NOTHING`，仅改 JSON 或重跑 seed 不会更新生产。同步前后读回启用数 666、地址与权限不变。

新过滤只影响后续发现，不自动删除历史附件、修改已发布内容、重置历史水位或回执。不清理付费状态不明或正在执行的请求。历史附件若需撤选，先按来源和确定 URL 形态生成审核清单，保留原始材料及审计证据。
