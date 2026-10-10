# 第 18 号 agent：五项旧 skip 审计与恢复

日期：2026-10-11。范围仅为五项带原因跳过的测试及其相关生产实现。没有读取 `.env`，没有调用外部模型、操作生产或提交代码。

## 五项分类及实际修复

| 测试 | 原因与当前状态 | 本轮有效夹具/断言 |
|---|---|---|
| story-digest：未引用机构不能进入标题 | 身份守卫已经在生产实现，旧 capability registry 原因过时；原文案不足当前 60 字下限，不能到达标题守卫 | 使用足够长的签名 digest、独立 requestId；强断言 digest 成功写入而未知机构标题保持原值 |
| story-digest：并发写作版本 | 实现已有故事行锁及 max(故事版本,历史最高版本)+1；旧断言还把 SELECT version 行当作 r.v 读取 | 使用有效长文案、两个不同 requestId；先验证历史版本 9 后落 10，再强断言两个并发写作都成功且版本为 11、12；修正 SQL alias |
| publication-read-guards：非法分页 offset | guards 已存在；旧夹具每个 fact 只有一个成员，且 publications 未关联 story/fact，无法真正生成两个前缀游标 | 同一 fact 多报道，同时保留多 facts；连接真实 publication story/fact；强 assert gr1/dv1 nextCursor；正常游标 200，null/string/object/fraction/negative/nonfinite 均 400 |
| publication-issue-gate：日报引注页面与 RSS | 可读/撤回规则正常；缺失本地行的引注需要保留但不能假称有本站页 | 原文回退、禁止缺失站内 URL；hasPage=false/available=true 的 imported 引注，summary-only hasPage=true；V1 aihot=null、attribution 回退刊期 |
| rss-conditional：三种刊期目录与条件请求 | 日报旧断言错误要求缺失 item 站内地址；重新运行还暴露真实 RSS 投影缺陷 | 日/周/月原文回退、不存在本站链接；legacy links.original；无 itemId 的原文链接与无地址纯文字；三种 feed ETag 304/空响应继续验证 |

这五项均属于现役功能，不能归因为 FEATURES 中刻意关闭的 leaderboard 或 codexResetMonitor。

## 本轮发现的真实缺陷与根任务修复

1. **P2：RSS 原文地址在索引投影丢失。** tocHtml 已有 sourceUrl 回退代码，但 reportIndexRows 只保留 itemId/title；实际执行新 weekly 原文断言失败。根任务补索引 sourceUrl（兼容 legacy links.original），并处理无 itemId 原文链接。本 agent 保留严格断言，没有放宽生产规则换取测试通过。
2. **P2：导入刊期本站不存在条目页仍被网站/API 链接。** 读层需区分保留引注与本站有页面。根任务新增可选 hasPage，网站标题/导读/看点/快讯使用原文或纯文字，V1 aihot=null、归因刊期；available、撤回与放行闸规则不变。独立审查了最终 diff，并真实验证 API/RSS 行为；本 agent 未进行浏览器点击验收。
3. **P2：USGS/CGS 词表碰撞。** 原裸“地质调查局”同时给美国名称授予 CGS；纯函数实际复现忠实 USGS 中文稿被清空、反向错署 CGS 获得 pass。identity_entity_repair 按根任务授权仅删裸分支并改正旧 DEFECT 绿断言；本 agent 独立审读最小 diff，未修改其文件或冒称复跑其 23 项。

docs/known-issues.md 第七轮小节关于 registry 未接通、版本仍并发冲突、五 skip 状态已经过时，后续根任务应保留历史说明并附本轮关闭记录。早期“线上全部来自人工 fixture”的影响描述也不能代表当前生产真模型环境。

## 真实独立验收

创建唯一 `geohot_a18_legacy_skip_test` 于 localhost:5433，应用 53 项迁移并初始化 pg-boss schema。所有模型端点均为测试文件的 localhost stub；RSS 为本机 HTTP stub，没有真实外发。最终运行：

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/story-digest.test.ts tests/publication-read-guards.test.ts tests/rss-conditional.test.ts tests/publication-issue-gate.test.ts
node node_modules/typescript/bin/tsc -p tests --pretty false
```

最终 **21 tests / 21 pass / 0 fail / 0 skip**，运行 6870.5909 ms，退出 0；tests 类型检查退出 0。恢复的是原五个 skip，各测试有有效输入和严格断言，不是单独取消 skip。综述回执 cleanup 按本测试 story subject 精确删除；RSS private-fetch 运行时设置还原。

测试结束删除且确认测试库查询返回 `[]`；原生产数据库未访问。当前结论只对应本地最终补丁及列出的回归，不能替代最终版本部署、移动浏览器点击、所有内容溯源或生产持续采集验收。
