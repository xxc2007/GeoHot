# USGS / CGS 身份误判的生产影响审计

审计时间：2026-10-11 07:57–08:00（Asia/Shanghai）。本次仅执行生产数据库 SELECT 和内存内纯函数判定，没有排队、修改数据库、外发模型请求或写入服务器应用文件。未输出原文、完整模型响应、环境文件或凭据。

## 范围与方法

- 对每篇文章按 `created_at DESC, id DESC` 取最新分析，并要求 `input_revision = articles.revision`。
- 找出 `output.identityGuard` 的标题或摘要不支持实体列表包含 `cgs` 的记录。
- 在服务器进程内读取这些记录关联的既有写作回执，按现有写作解析函数解析字段，分别运行现行词表与仅删除 CGS 裸“地质调查局”分支的词表。内存词表变体不落盘。
- 用当前原始分析输入重建写作提示词，比较回执的 `userHash`、`systemHash`、`promptVersion`，并按既有模型规格与原始无强制重跑的步骤标签重建完整 `logical_key`。没有通过调用模型验证缓存。
- 另检查最新、同 revision、中文标题或摘要含“中国地质调查”的分析，用修复后的身份判定检查是否为仅有 USGS 证据的错误 CGS 归属。

## 误拒的四条记录

四条均为 `origin=model`、`relevance=unknown`、revision 2，来源证据只识别 USGS。现行词表在摘要上错误报告不支持 `cgs`；修复后的纯函数判定全部为 `pass`，标题、摘要原始中文字段均存在。以下只登记标识，不刊载原文或模型回答。

| 文章 ID | 最新分析 ID | 来源 ID / 注册主体 | 写作回执 ID / 步骤 | 当前写作逻辑键可精确复用 |
| --- | ---: | --- | --- | --- |
| `a51i6hdkkb2wd89unbatsrolc` | 13031 | `json-usgs-quake-m45` / `usgs` | 72240 / understand | 是 |
| `b0jysyz8q3udil3m1mzw9ydxd` | 13126 | `json-usgs-quake-m45` / `usgs` | 72871 / summarize | 是 |
| `iotduoratn8xsaqsbm7jq9542` | 11861 | `rss-phys-org-earth` / 无注册主体 | 63524 / understand | 否；既有提示词版本和 systemHash 已不同 |
| `ut5kfwwlzifd864pkavoituo2` | 13181 | `json-usgs-quake-m45` / `usgs` | 73217 / understand | 是 |

四条写作回执及各自关联的预筛、结构、两次评分回执状态均为 `completed`，subject 都与当前 `article:<id>@2` 一致。四条写作回执都使用原始步骤标签 `understand` 或 `summarize`，没有人为强制重跑标签。

表中三条“是”的含义需精确理解：这三条写作回执当前的完整逻辑键相同，可以通过原有回执机制复用；这里未证明所有其他步骤的当前逻辑键均与历史相同，也未执行实际队列回放，不能据此承诺整条分析绝不新增请求。

Phys.org 条目的当前 userHash 与原回执一致，但 `promptVersion` 和 `systemHash` 不同，完整逻辑键不同。这是既有提示词演进导致，与本次删除词表分支无关。普通重新排队不能保证复用该旧写作回执；不应伪造逻辑键、覆写回执或直接把旧中文稿与分数写成新分析。

本次词表变动本身不改变四条写作提示词的 userHash。身份上下文提示只输出发布域及注册主体，允许实体集合仍由最终守卫读取，因此删除裸分支不会使上述三条匹配的写作回执失效。

## 反向错误归属检查

当前最新且同 revision 的中文稿含“中国地质调查”的记录共 **5 条**，全部 `origin=model`、`relevance=pass`，来自 `web-cgs-ddyw`，注册主体为 `cgs`，源证据也明确匹配 `cgs`。修复后的守卫全部为 `pass`；本次范围内仅有 USGS 证据却署名 CGS 的稿件为 **0 条**。

| 文章 ID | 最新分析 ID |
| --- | ---: |
| `c7maz2wdr27umicx80g2tzpt8` | 5746 |
| `jfuoxu8e1swmp57bmrj2yo3jg` | 5742 |
| `lgcxs35manikj9qgmg40ofxcq` | 10741 |
| `sdw9lb1z1gj7r3g4c2yqz3uuc` | 5749 |
| `tdt2jao3e08zrxbeqs7updnvi` | 5745 |

## 后续处理建议与边界

部署修复后，可由根代理通过既有 `queueProcessing` 路径重新排队受影响记录，保留 revision、不增加强制 `attemptTag`，让已有缓存与正常预算机制决定是否发起请求，继续按原有预筛、双评分、写作与结构工作流产生结果。对提示词已变化的 Phys.org 记录应单独标记：若要求严格零新增模型请求，应先验证全步骤缓存是否齐全，再决定回放路径；本次未做该变更。

修复身份判定不代表四条必然入选，也不表示已发布。本文只确认这四条既有中文写作被误拒，以及五条当前已保存 CGS 署名没有发现同类反向错署名；未扫描所有历史版本、所有原始失败响应或其他机构的潜在身份误判。
