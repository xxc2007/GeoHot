# 2026-10-11 08:09 旧 running 切片与出版闸门复核

通过既有私有 remote helper，在 READ ONLY 事务内复查生产，观测 UTC 2026-10-11T00:09:03Z（北京时间 08:09）。没有修改生产、slice 状态、预算、回执、分析或队列。根任务正在独立部署与 draining，本 agent 未碰生产服务。私有计数证据为 `.round11/archive-stale-gates-20261011.log`。

## IJGIS 2026-01 不会被正常选择器排除

生产来源 `rss-ijgis-toc` enabled=true、participation_mode=editorial、kind=rss、ISSN=1365-8816、fail_count=0。它满足正常期刊档案来源条件。`deploy/geohot/archive-cycle.sh` 的 sources 查询只要求 enabled 加非空 issn/archiveIndexUrl；done 集合仅包含 status=done，eligible 对过去月份只排除这个集合。因此 running 和 pending 都会参与后续轮转，不需要先手动 UPDATE 成 pending。

脚本本身 `archiveSliceCursor` 也只跳过已闭合月份的 done；过去月份 running + null cursor 会从 `*` 开始。这条记录的真实状态为：status=running、cursor=NULL、seen=0、items=0、note=NULL、updated_at=2026-10-09T17:52:23Z，约 30 小时未更新。该源 3/4/6/7/8/9 月于前夜成功重跑为 done，证明源仍可参与正常处理，但不能代替 1 月的覆盖证据。1 月库里现有四条资料都是 new、没有分析/投影，不能从 slice.items=0 推断没有材料。

只读状态支持“很早的 running 标记未完成落盘”；不能定位当次到底是终止、超时、机器重启还是未捕获异常。代码在先写 running 后读页，正常 HTTP/解析失败会走最终 pending 更新；这次 running 的 null note/零计数更符合过程在最终更新之前被打断，单凭 fail_count=0 不能证明档案 fetch 从未失败（该计数主要是常规来源采集状态）。本次没有可关联该次进程的历史错误日志，因此不把推测写成已复现根因。

## 最小安全恢复

优先让现有同锁 timer 正常捡起该 eligible slice；如果根任务要定向恢复，则等部署锁释放后，在原 `cycle.lock` 下只重跑这一个月，保留 ledger、材料、已存分析与回执，不能将它直接标 done，也不必清空 cursor 或重置 paid receipts。

```bash
sudo -n -u geohot /bin/bash -c '
set -Eeuo pipefail
umask 077
cd /opt/geohot/app
log=".data/archive-cycle/ijgis-202601-$(date -u +%Y%m%dT%H%M%SZ).log"
flock -n .data/archive-cycle/cycle.lock \
  timeout --signal=TERM --kill-after=30s 600s \
  /usr/bin/node --max-old-space-size=192 --env-file=.env \
  scripts/backfill-archive.ts \
  --source=rss-ijgis-toc --from=2026-01 --to=2026-01 \
  --max-items=100 --per-month=100 --per-page=100 --sleep=1200 \
  --apply --database-url-env=DATABASE_URL >"$log" 2>&1
printf "private log=%s\n" "$log"
'
```

这是交给根任务的命令，未执行。锁被占用会立即退出，不会与周期或部署并行。结束后只读查询该 slice 的 status/cursor/note/updated_at；pending/error 保持未完成，只有正常尾页证明才能由脚本写 done。若又超时 running，需要检查对应私有日志中的退出状态；不从未打印凭据的日志中外抄整段错误。

## 283 天为何没有最终 settled

范围为 2026-01-01 北京时间零点至 2026-10-11 零点之前，共有资料 23,549 条、283 个资料日期。

| 独立条件 | 当前条数/日期 | 是否阻止原补刊 settled 闸门 |
|---|---:|---|
| processing_state=new | 9,756 条，283 天都有 | 是 |
| analyzed 且无 publications 行 | 0 条，0 天 | 是，但本次不是瓶颈 |
| analyzed 且当前最新分析 relevance=unknown | 2,875 条 | 否；其中无投影为 0 |
| processing_state=failed | 33 条，分布 19 天 | 否；按原规则视为不会自动完成的终态 |
| processing_state=blocked | 1,763 条 | 否，真实拒绝终态 |
| 任意状态无 publication | 9,781 条 | 不能全部算投影故障，绝大多数是尚未分析的 new |

这里 unknown 的 2,875 是全部来源与 origin 的当前 revision 最新分析，不等于主动 archive 的真模型 unknown。前一份 08:07 报告已单独确认 archive/model unknown 28、真 pass 160、block 207。

所有 283 天都有 new，且没有纯粹被缺失投影卡住的一天。因此当前不能靠 publication repair、提前 force 出刊或把旧 slice running 改状态来产生真实最终闭合。扫队列中的确定性投影补救已经没有缺口；现有 content.sweep 只对 new 重新排队并补 analyzed 无投影，不会自动重跑已 analyzed unknown，也不会自动恢复 failed。

单纯提高有效处理速度能使 new 更快走到终态、满足原刊物闸门，但不足以证明内容任务最终质量完成：unknown 已有投影仍不代表通过，failed 未阻止出刊仍需记录原因和处理边界，未完成期刊采集还会给历史日期带来新材料。根任务应继续保持预算和双评分，先评估已授权退避/拒收修复后的有效 pass/block 增长；对 archive/model unknown 28 与 archive failed 4 另做原因分类与有界恢复，遵守 unknown receipt 不重送、相同 revision 回执复用，不批量清回执。等来源切片资格与 new 队列稳定后，再正序 refresh 最终刊物。
