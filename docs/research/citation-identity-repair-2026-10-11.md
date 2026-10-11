# 刊物引注与机构身份修复

本轮由 root 与第 18 名审阅 agent、专门身份修复 agent 协作完成。本地修改没有调整选择分数、门槛、发布时间、原文或模型预算。

## 已修复的生产路径

- CGS 的裸“地质调查局”词表曾把“美国地质调查局”同时认作 USGS、CGS。英文 USGS 源的忠实中文稿因此可能被拒，中文稿冒名 CGS 也可能漏检。删除仅该泛称分支，保留中国限定名和 CGS 缩写，双向错误归属、同句双主体、全角/空格/缩写边界回归通过；没有扩大算法或门槛。
- 导入刊物引用本库不存在的条目时，保留原引注和 available 状态，新增 hasPage 区分是否存在可读本站页。网站标题、头条、快讯和看点在没有本站页时使用原文；没有地址则只显示文字。V1 的 links.aihot 为 null，attribution 回退到刊期。撤回/放行期与可读刊期规则保持原样。
- RSS 原有原文回退分支曾得不到精简索引投影丢弃的 sourceUrl。索引现在保留 sourceUrl，并兼容旧 links.original；无 itemId 的原文也可引用，没有地址不生成空链接。投影没有重新加入全文或摘要。

## 验证证据

五个旧 skip 的有效夹具已恢复并实际运行；完整明细见 `legacy-skip-audit-2026-10-11.md`。旧断言原先过短的综述不能到达身份守卫，版本查询字段错误，分页没有真实游标，不能仅删除 skip 就冒称已测。

根新隔离库完整后台回归 **443/443 pass，0 fail，0 skip**；前端 **51/51 pass，0 fail，0 skip**。全部工作区类型检查通过。前端测试首次误用前缀部署构建，十项固定根路径的 SSR 夹具返回 404；按其明确要求重建根部署后完整通过，生产另重新以 BASE_PATH=/geohot 构建。不是修改预期状态码制造通过。

新增真实 ReportPaper SSR 组件回归检查缺失引用不生成不存在本站页，有页引用仍走详情页，无地址没有 href=""。初版测试发现 Original 仍渲染空地址链接，修复后通过；这项实际渲染覆盖标题和快讯，没有冒称真实移动浏览器点击。

身份与行业词表由专门 agent 独立验证 23/23；五 skip 相关四个测试文件由第 18 名 agent 独立库验证 21/21。两个 agent 均没有外发模型或操作生产。根完整后台原始日志 `citation-identity-whole.log`，前端根构建回归 `citation-identity-web-root-tests.log`，生产构建 `citation-identity-web-production-build.log`，最终类型检查 `citation-identity-typecheck-final.log`。

生产影响只读查询发现四条最新同 revision 分析曾记录 CGS unsupported 且 relevance unknown。不能直接将这些记录写为通过，部署后仍应走正常处理、原中文守卫和原双次评分；精确缓存复用和实际结果另记。

## 生产部署与正常重排

14b5970 已实际部署，源码与 BASE_PATH=/geohot 构建上传时 SHA256 校验通过；共享档案锁下排空唯一分析 worker 后更新，四服务恢复 active，档案 timer 恢复。启动健康探测曾出现两次 502，随后公网 release=14b5970、db=ok；完整 verify-deploy.sh 返回 ALL CHECKS PASSED。第 18 名 agent 独立确认源站及公网健康、日报 10-11 与周报 W40 SSR 200、无空 href、抽查条目 200；最新刊期没有缺失引注，因此该分支的证据仍为隔离数据库与真实组件 SSR 回归。

四条审核对象确认 revision=2 后，经 queueProcessing 原入口重新入队，未添加 attemptTag，未变更日期、版本、分数、选择门槛或预算。最初只读快照误写 current_revision 字段，查询失败，未排队；改为真实 revision 字段后才执行四条正常入队。

08:06 后的只读结果：a51i6hdkkb2wd89unbatsrolc 产生分析 15266，b0jysyz8q3udil3m1mzw9ydxd 产生 15267，均 revision=2、relevance=pass、processing_state=analyzed，但 selected=false，不能称为新增精选。它们复用既有四条回执，分别另有结构回执 85763、85766，不声称完整处理零新增模型请求。iotduoratn8xsaqsbm7jq9542、ut5kfwwlzifd864pkavoituo2 尚在正常预算重试，旧 unknown 结果未被手改。

源站和公网月报索引仍为 0，2026-09 存在空期刊但 readable=false、citations=0，与部署前一致；不是已完成月报补刊，也不是这次引用链接修改引入的回归。完整历史筛选、月报出刊、最终 GitHub 同步及最后迁移备份仍待完成。
