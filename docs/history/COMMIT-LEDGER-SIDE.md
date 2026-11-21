# 侧分支提交台账（GEOHOT）

覆盖 `git log --all --not HEAD` 的提交：这些提交不在当前 `main` 的历史上，但存在于仓库的侧分支/远端 ref。

生成命令：`git log --all --not HEAD --reverse --date=short --format="- \`%H\` · %ad · %an · %s%d"`

- `f0bdadcdd83b83da5e7e541df337545533f80090` · 2026-10-18 · 熊鑫晨 · feat(pipeline): bounded analysis offload and official pause-gap recovery
- `e576ec8a1bf636cb57f6fcd773c814a51b7152d4` · 2026-10-18 · 熊鑫晨 · fix: bound translation continuation and isolate historical acceleration
- `fd28cee8d03268683e7699f1c6b3951c4af45eba` · 2026-10-18 · 熊鑫晨 · fix: give Step summaries bounded reasoning headroom with legacy receipt recovery (codex/geohot-takeover-20261018)
- `515f64851ce496100d159aa0507e2870c87c8050` · 2026-10-20 · 熊鑫晨 · fix: invalidate stale source approvals and preserve rejected history (codex/source-registry-review-fixes)
- `5d6208ec8aef15b24f73888e69d01ff41676ce9b` · 2026-10-20 · 熊鑫晨 · feat: preserve strong material aliases and source observations
- `4f3483efde00cb25299b6f7c9c8109d3324781b9` · 2026-10-20 · 熊鑫晨 · fix: require source evidence for automatic selection (codex/geohot-selection-evidence)
- `48f0f70f88b9b97d008488fce675fd70ee564720` · 2026-10-20 · 熊鑫晨 · fix: quarantine conflicting DOI evidence and order canonical batch locks (codex/material-strong-aliases-0073)
- `719007dd073a3eeb0c1586f24bb1720777699cc3` · 2026-10-20 · lead · feat(models): register qoder-cn gateway presets (dfmodel/qfmodel) with budget row (feat/qoder-cn-pool)
- `10d416f09d3473f3e8085690299ccad7848c2b65` · 2026-10-20 · 熊鑫晨 · fix: filter CEMADEN image wrappers and complete five source owners (codex/geohot-source-quality-batch-20261020)
- `815836448307f8482d7bd15ba87b169146984e15` · 2026-10-22 · 熊鑫晨 · docs: add bilingual architecture flow diagrams (origin/codex/readme-architecture-20261022, codex/readme-architecture-20261022)
- `70837aaac43442ecc1c1a6f1200fd19e0da361b7` · 2026-10-22 · 熊鑫晨 · docs: fix diagram label collisions and remove Chinese footers
- `de8250e899e274a81d935d0f05590d4525cfc6cb` · 2026-10-22 · 熊鑫晨 · docs: keep short-gap labels clear of decision borders (origin/codex/fix-diagram-labels-20261022, codex/fix-diagram-labels-20261022)
- `171735ea3346038416cc012b6f9918b4cfce06b8` · 2026-10-22 · 熊鑫晨 · docs: add GeoHot security policy (origin/codex/add-security-policy-20261022, codex/add-security-policy-20261022)
- `962358f0cf03eb9de65f8bbca4d9157c01ab3a96` · 2026-10-28 · 熊鑫晨 · docs(changelog): 补齐10月26日至28日已部署更新 (origin/codex/changelog-catchup-20261028, codex/changelog-catchup-20261028)
- `e6f60ee28bd1dad0423135615adde65ef37a5046` · 2026-10-28 · 熊鑫晨 · docs(release): 明确GitHub提交与三端同步的发布要求 (origin/codex/release-sync-policy-20261028, codex/release-sync-policy-20261028)
- `8039a98855d249d60b689a84267e985bb62a6d86` · 2026-10-28 · 熊鑫晨 · docs: 提供可点击放大的高清PNG架构图 (origin/codex/readme-png-zoom-20261028, codex/readme-png-zoom-20261028)
- `16a73f2ff9737e143a2399f78d3a55d788908be5` · 2026-10-30 · 熊鑫晨 · index on main: 0faa207 docs(changelog): 记 10-22/23 这一轮：角色错配、预算查询索引、推理拉满、信源回 666
- `7bee7259fed07b9ed932f6af79f83740b6d18d74` · 2026-10-30 · 熊鑫晨 · On main: stale-workspace-baseline-0faa207 (refs/stash)
- `8bd7ecf05ffbf6bcfe55be0439e66a47abd91053` · 2026-10-31 · 熊鑫晨 · feat: 每日闲时官方价核对 timer + 汇率走官方 refreshFx 落库 (feat/pricing-check-fx-20261031)
- `14f06d3087ce1159485a37bca8440ab4a9039f3b` · 2026-10-31 · 熊鑫晨 · feat: 联系邮箱落真实地址+二维码占位下线；官方费用单值+汇率单一来源；预算退役路径+运行页余量放宽 (feat/contact-qr-pricing-20261031)
- `3e2ede9c911e7f1c31e8f2a62c6457dbb106e93f` · 2026-10-31 · 熊鑫晨 · fix: pricing-check 退出码分级——diffs>0 才算任务失败(1)，refreshFx 链路故障(2)，页面解析失败只落库不挂 failed (fix/pricing-check-exit-code-20261031)
- `cc8f33661f2807826363de787b07f34aec770a56` · 2026-11-03 · xxc2007 · hardening(systemd): 三单元模板回写服务器沙箱加固决定
- `be3e35dab0d2fb1c50ccdc7f25393f8c7e94f6f8` · 2026-11-04 · xxc2007 · chore(deploy): 注明 bin 同步的由来，触发一次完整 CI (origin/fix/deploy-installs-gate-scripts-20261104, fix/deploy-installs-gate-scripts-20261104)
- `683e757ff41abcc7eace9fa24d6a4cf26aac0fd8` · 2026-11-05 · xxc2007 · fix(web): 视图过渡被作废时，外观选择不能跟着丢 (origin/fix/web-theme-transition-20261105, fix/web-theme-transition-20261105)
- `5ce9241eca3a41d2e733f09a77c0573cd99bfe55` · 2026-11-07 · xxc2007 · fix(window): 夜档切档别再叫醒 readers-only 机器上的 worker
- `cfe43e2700489a7408471a8806654fe57987e4d7` · 2026-11-07 · xxc2007 · fix(db): 给 /all 补一条不带 eligible 的部分索引
- `dcd7901d8dc92c8e1e6f809ba038b5e81866a282` · 2026-11-07 · xxc2007 · test: 切档用例先剥注释再判位置（readers-only 判据插在 fence 之前） (origin/fix/all-page-index, fix/all-page-index)
- `e90e7c6a1ea1bdbac651c53f36fea914c4f895e7` · 2026-11-07 · xxc2007 · test: 切档用例先剥注释再判位置（readers-only 判据插在 fence 之前） (origin/fix/window-readers-only, fix/window-readers-only)
- `f58d184bfac409fb6dc95cf5cd9a101764c9c833` · 2026-11-08 · xxc2007 · fix(routing): 池首成员被静默饿死时保留一个探针位
- `051c82dbd43b2859016b255618850ecd65fd69e2` · 2026-11-08 · xxc2007 · fix(routing): 池首成员稳定拿到一半额度
- `0417840d90ac234aadfe02672c5c01356f60f5b2` · 2026-11-08 · xxc2007 · fix(routing): 池首按配置顺序取，并每个进程打一行池子快照
- `59baa6bf2f06853801131971155d66660607d8f0` · 2026-11-08 · xxc2007 · fix(routing): 配置里的池首始终进服务集 (tag: 30fb555)
- `4265133e27a4967a33f5f90c1714721cc854a93b` · 2026-11-08 · xxc2007 · fix(routing): 判病的池首只记账、不重新派活 (tag: 523e88c, feat/admin-content-infinite)
- `5a618d9f655e557c97785c27984d6360d0a19611` · 2026-11-16 · lead · perf(topics): 主题计数缓存与页面缓存同频（1 分钟 → 5 分钟） (origin/perf/topic-counts-5min-20261116, perf/topic-counts-5min-20261116)
- `43ecd2873a1594ae6832f14d85178a6af758fa0e` · 2026-11-16 · xxc2007 · security(sources): fast-xml-parser 5.11.1 → 5.12.0 (origin/chore/fxp-512-20261116, chore/fxp-512-20261116)
