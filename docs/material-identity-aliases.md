# 强材料身份与来源观察

0073 仅新增空的 alias、来源观察和身份冲突表，不重写既有文章、receipt、历史报刊或公开引用。所有入口仍使用 `upsertMaterial`；原 `articles.identity_key`、article ID 和来源所有权保持稳定。

仅既有规范 URL、显式主文档 DOI、DOI resolver 整条路径，以及既有显式 identity 参与强身份解析。DOI 只从结构化字段或 resolver URL 取得，按一次解码、格式校验与大小写规范化处理；不从正文、标题或参考文献推断。不同页面且没有共同 DOI/已登记 alias 的材料保持独立。保留 fragment 的 section 不取得父页面或父文档 DOI alias。不同 DOI 指向相同 URL 的矛盾输入隔离，不按事件/标题相似度合并。

事务顺序为来源 `FOR KEY SHARE`、排序后的所有候选强键 advisory transaction lock、canonical article 行锁、alias/discovery/observation/revision 写入。HTTP 已有来源 `FOR UPDATE`，并在首条材料前预锁整批强键，然后解析整批既有 alias/legacy 行并按 canonical ID 排序锁住全部行。仅排序 incoming URL 不够：互不相同的 URL aliases 可能反序指向同两条 canonical 行。唯一 alias 是最后的所有权约束；既有 alias 从不重指向另一 article。所有入口必须升级后再并行恢复写入，旧二进制不遵守 advisory 锁，不能混跑。任意外部手写事务也须遵守该锁序。

相同材料返回原 article ID，跨来源只增加发现与观察，不获得修改 canonical copy 的权限。同来源正常更新继续使用既有 revision/content hash 规则。归档两门显式 `observationOnlyExisting`，即使同来源的摘要和标题不同，也不覆盖现有正文或产生付费 revision。归档先前的 URL 提前跳过已移除，因此重复入口仍能保留发现。原 site 期日修正仍限定 canonical article 的 source 所有权。

`material_observations` 保留输入 MaterialInput 和可用原入口 rendering；RSS/Atom 保存 parsed entry、Crossref 保存 work、curated/HTTP 保存原 item。它不是完整网络字节抓包，也不能恢复上线前已经丢失的原始 payload。按 article/conflict、source、via 和输入哈希幂等；自动抓取的 discoveredAt 不参与哈希，同一原始材料重复轮询不复制存储。不同 body/raw/rendering 则保留独立观察。私有观察不进入公开 reader、模型提示或自动 canonical 升级。

多个既有 article ID 命中、或 DOI 自相矛盾时，新增冲突记录和完整来件观察，返回 `quarantined`、`conflictId`、created/revised=false、空 articleId。空 ID 不代表可读取的文章；调用者只可在 created/revised 时排新模型工作。HTTP 返回202和逐项拒绝原因；全批冲突仍提交私有证据，而不是抛错回滚证据。curated 避免后续 reanchor，archive/news 不把该页标作完整完成。没有自动删除/alias偷取/退款/receipt重置/旧报告改写。

现存 DOI-only 的精确原始 URL 通过已有 `articles_url_idx` 查询桥接。历史 tracking URL 或不同 DOI 编码要先做受控种子登记：

```
node scripts/seed-material-aliases.ts --after=<lastArticleId> --limit=25
node scripts/seed-material-aliases.ts --after=<lastArticleId> --limit=25 --apply --database-url-env=DATABASE_URL
```

必须由操作者显式设置目标 DATABASE_URL；脚本默认 dry-run，每次最多100行，用 article ID keyset，不做 OFFSET/全库正文扫描。每条应用事务 lock_timeout=1500ms、statement_timeout=5s，先核验 legacy identity/URL 仍与 bounded snapshot 一致。无 canonical/revision 更新。打印 nextAfter 作为人工/外部受控持久 checkpoint；重复批次幂等。冲突保留并计数，返回2；不能将 fullyMerged=false 或 exhausted=true 解读为所有历史重复已清完。发生错误不输出成功 checkpoint，必须重试该批或审查原因。

生产先备份并核查空间，再迁移0073，升级全部入口、排除旧 writer，按界限批次种子登记并审核冲突后恢复并发。新表为空不意味着历史 alias 已齐全。旧重复公开项的合并、supersession/旧链接兼容、报刊修订和质量评审属于独立后续任务。不会因本补丁自动清空所有历史重复。

观察表增长受入口现有 body/raw/request 大小限制，但本补丁没有总库配额、自动保留清理或后台审核 UI。显式删除文章沿既有关系级联删除其 alias/观察；本补丁本身不会发起删除。若生产要求跨显式硬删除的法定保留，须另行定义脱敏与保留策略。默认不得用删除旧文章代替身份冲突审核。
