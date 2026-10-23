#!/usr/bin/env bash
# Bounded archive collection and settled publication. Does not start another worker.
set -Eeuo pipefail
umask 077

APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
NODE="${GEOHOT_NODE:-/usr/bin/node}"
STATE_DIR="${GEOHOT_ARCHIVE_STATE_DIR:-$APP_ROOT/.data/archive-cycle}"
ENV_FILE="${GEOHOT_ENV_FILE:-$APP_ROOT/.env}"
FROM="${GEOHOT_ARCHIVE_FROM:-2026-01-01}"
TO="${GEOHOT_ARCHIVE_TO:-$(TZ=Asia/Shanghai date +%F)}"
APPLY="${GEOHOT_ARCHIVE_APPLY:-0}"
FINAL_REFRESH="${FINAL_REFRESH:-0}"
MAX_ITEMS="${GEOHOT_ARCHIVE_MAX_ITEMS:-100}"
PER_MONTH="${GEOHOT_ARCHIVE_PER_MONTH:-30}"
PHASE_SECONDS="${GEOHOT_ARCHIVE_PHASE_SECONDS:-600}"
SLICES="${GEOHOT_ARCHIVE_SLICES:-6}"
# 摘要下限允许 0（"只认标题与日期的行也交给编辑闸门判"），所以不许套用上面那条"正整数"的校验；
# 但同样要在门口拒绝非整数，否则这道闸会静默失效而台账里看不出来。
MIN_ABSTRACT="${GEOHOT_ARCHIVE_MIN_ABSTRACT:-80}"
# 翻页门（`industry/news-archives.json`）每轮走访几扇。规则铺到 50 条之后这里还只走 1 扇，一趟就要 12.5 小时，
# 而生产实测一扇门 2—3 页只落 1—10 条、采集本身只要 15—25 秒——瓶颈是轮数，不是墙。
NEWS_DOORS="${GEOHOT_NEWS_DOORS:-3}"

fail() { printf 'archive-cycle: %s\n' "$1" >&2; exit 2; }
[[ "$APPLY" =~ ^[01]$ && "$FINAL_REFRESH" =~ ^[01]$ ]] || fail 'apply and final-refresh must be 0 or 1'
[[ "$FROM" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$TO" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail 'invalid date format'
[[ "$FROM" < "$TO" || "$FROM" == "$TO" ]] || fail 'invalid date range'
for value in "$MAX_ITEMS" "$PER_MONTH" "$PHASE_SECONDS" "$SLICES" "$NEWS_DOORS"; do
  [[ "$value" =~ ^[1-9][0-9]{0,5}$ ]] || fail 'limits must be positive integers'
done
(( MAX_ITEMS <= 2000 && PER_MONTH <= 500 && PHASE_SECONDS <= 1800 && SLICES <= 12 && NEWS_DOORS <= 8 )) || fail 'limits exceed cycle safety caps'
[[ "$MIN_ABSTRACT" =~ ^(0|[1-9][0-9]{0,4})$ ]] || fail 'min-abstract must be a non-negative integer'
[[ -d "$APP_ROOT" && -r "$ENV_FILE" && -x "$NODE" ]] || fail 'app, environment file or Node unavailable'
for utility in flock timeout date; do command -v "$utility" >/dev/null || fail "missing $utility"; done
cd "$APP_ROOT"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/cycle.lock"
lock_result=0
flock -n 9 || lock_result=$?
if (( lock_result == 1 )); then
  printf 'archive-cycle: another cycle holds the lock; skipped\n'
  exit 0
fi
(( lock_result == 0 )) || fail 'flock failed; lock implementation unavailable'

RUN_DIR="$STATE_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$RUN_DIR"
NODE_ARGS=(--max-old-space-size=192 "--env-file=$ENV_FILE")
# Optional one-time overlay; Node parses dotenv rather than executing shell text.
if [[ -n "${GEOHOT_ARCHIVE_ENV_OVERLAY:-}" ]]; then
  [[ -r "$GEOHOT_ARCHIVE_ENV_OVERLAY" ]] || fail 'overlay unavailable'
  NODE_ARGS+=("--env-file=$GEOHOT_ARCHIVE_ENV_OVERLAY")
fi
WRITE_ARGS=()
if [[ "$APPLY" == 1 ]]; then WRITE_ARGS=(--apply --database-url-env=DATABASE_URL); fi
printf 'archive-cycle: range=%s..%s apply=%s final-refresh=%s ledger=%s\n' "$FROM" "$TO" "$APPLY" "$FINAL_REFRESH" "$RUN_DIR"
DEADLINE=$(( $(date +%s) + 2400 ))
STOP_REQUESTED=0
# A managed stop drains the current Node phase; never start another collection or paper phase.
trap 'STOP_REQUESTED=1' TERM INT

run_phase() {
  local name="$1"; shift
  if (( STOP_REQUESTED )) && [[ "$name" != status-after ]]; then return 143; fi
  printf 'archive-cycle: phase=%s started\n' "$name"
  local result=0
  local remaining=$(( DEADLINE - $(date +%s) ))
  # Reserve the final minute for the observation snapshot, within the 40-minute cycle.
  if [[ "$name" != status-after ]]; then remaining=$((remaining - 60)); fi
  local seconds="$PHASE_SECONDS"
  if (( STOP_REQUESTED )) && [[ "$name" == status-after ]] && (( seconds > 15 )); then seconds=15; fi
  (( remaining < seconds )) && seconds=$remaining
  if (( seconds <= 0 )); then
    result=124
  else
    # GEOHOT_PHASE_SECONDS：把"这一档还剩多少秒"交给会花钱的那一支。出刊脚本
    # （`scripts/backfill-papers.ts`）据此在**最后一次付费调用还能跑完**之前自己收工，
    # 而不是被这里的 SIGTERM/SIGKILL 掐在调用中间——那样那一条请求的收据会停在 pending，
    # 被清扫器判成 unknown，而 unknown 对那一条 logical_key 不再自动重发（可能已经计费）。
    # ops.recover 会在半小时后**自动放行一次**（admin/runs.ts 的 autoReleaseUnknownReceipts），所以这一期不是丢定了，
    # 代价是**这一次已经付过钱的回答被扔掉**：于是同一个日期一轮一轮地重蹈，直到某次调用整个落在窗口里才出刊。
    # 2026-10-13 实测：papers 连续 14 轮全部 exit=124；daily 02-28 与 03-13 各这样连报七轮才排出来。
    # 第二次 unknown（自动放行之后又断一次的）才真的留给人工判。
    GEOHOT_PHASE_SECONDS="$seconds" timeout --signal=TERM --kill-after=255s "${seconds}s" "$NODE" "${NODE_ARGS[@]}" "$@" >"$RUN_DIR/$name.log" 2>&1 || result=$?
  fi
  printf '%s\t%s\n' "$name" "$result" >>"$RUN_DIR/exits.tsv"
  printf 'archive-cycle: phase=%s exit=%s\n' "$name" "$result"
  return "$result"
}

# Preserve a status snapshot even if collection or publication fails. Raw phase logs
# stay private: do not echo errors that may contain connection or provider details.
finish() {
  local result=$?
  trap - EXIT
  local status_result=0
  run_phase status-after scripts/archive-status.ts "--from=$FROM" "--to=$TO" "--out=$RUN_DIR/status-after.json" || status_result=$?
  if (( result == 0 && status_result != 0 )); then result=$status_result; fi
  printf 'exit=%s\nfinished=%s\n' "$result" "$(date -u +%FT%TZ)" >"$RUN_DIR/result.txt"
  # This pointer is not a success claim: inspect result.txt and exits.tsv.
  printf '%s\n' "$RUN_DIR" >"$STATE_DIR/latest.tmp"
  mv "$STATE_DIR/latest.tmp" "$STATE_DIR/latest"
  printf 'archive-cycle: completed exit=%s ledger=%s\n' "$result" "$RUN_DIR"
  exit "$result"
}
trap finish EXIT
CYCLE_RESULT=0
run_phase status-before scripts/archive-status.ts "--from=$FROM" "--to=$TO" "--out=$RUN_DIR/status-before.json" || CYCLE_RESULT=$?
# Query the authoritative database rather than the seed file. A numeric round-robin
# index advances before collection, so a failing slice cannot monopolise the next run.
SELECTOR=$(cat <<'NODE'
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { sql, closeDb } from '@aihot/backend/db';
import { beijingDate, isValidDate } from '@aihot/contracts/time';
import { archiveDoorFilter } from '@aihot/backend/sources/archive-site';
const [from,to,runDir,stateDir,wanted,maxItems,filter] = process.argv.slice(1);
if (!isValidDate(from) || !isValidDate(to) || from > to) throw new Error('Invalid archive range');
try {
  const sources = await sql`SELECT id FROM sources WHERE ${archiveDoorFilter(sql`sources`)} ORDER BY id`;
  const ledger = await sql`SELECT source_id,month,status FROM archive_ingest WHERE month >= ${from.slice(0,7)} AND month <= ${to.slice(0,7)}`;
  const done = new Set(ledger.filter(x => x.status === 'done').map(x => `${x.source_id}|${x.month}`));
  const current = beijingDate(Date.now()).slice(0,7);
  const only = new Set((filter || '').split(',').map(x => x.trim()).filter(Boolean));
  const months = [];
  let [y,m] = from.slice(0,7).split('-').map(Number);
  while (true) {
    const month = `${y}-${String(m).padStart(2,'0')}`;
    if (month > to.slice(0,7)) break;
    months.push(month);
    if (++m > 12) { m = 1; y++; }
  }
  const matchedSources = sources.filter(x => !only.size || only.has(x.id));
  if (!matchedSources.length) throw new Error('No matching archive sources; check enabled doors and source filter');
  const eligible = matchedSources.flatMap(x => months
    .filter(month => month >= current || !done.has(`${x.id}|${month}`))
    .map(month => ({ source: x.id, month })));
  let cursor = 0;
  try { cursor = Number(readFileSync(`${stateDir}/next-slice`,'utf8').trim()); } catch(e) { if (e.code !== 'ENOENT') throw e; }
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid slice cursor');
  const count = Math.min(Number(wanted),Number(maxItems),eligible.length);
  const start = eligible.length ? cursor % eligible.length : 0;
  const selected = Array.from({length:count},(_,i) => eligible[(start+i) % eligible.length]);
  const quota = count ? Math.floor(Number(maxItems)/count) : 0;
  const next = eligible.length ? (start+count) % eligible.length : 0;
  writeFileSync(`${runDir}/slices.json`,JSON.stringify({eligible:eligible.length,completed:eligible.length === 0,start,next,quota,selected},null,2)+'\n');
  writeFileSync(`${runDir}/slices.tsv`,selected.map(x => `${x.source}\t${x.month}\t${quota}`).join('\n')+(count?'\n':''));
  writeFileSync(`${stateDir}/next-slice.tmp`,`${next}\n`);
  renameSync(`${stateDir}/next-slice.tmp`,`${stateDir}/next-slice`);
} finally { await closeDb(); }
NODE
)
if run_phase select-slices --input-type=module -e "$SELECTOR" "$FROM" "$TO" "$RUN_DIR" "$STATE_DIR" "$SLICES" "$MAX_ITEMS" "${GEOHOT_ARCHIVE_SOURCE:-}"; then
  # The selector refuses missing doors or a mismatched filter. An empty valid selection means
  # all historical slices are done; paper refresh and news collection may still have work.
  if [[ ! -s "$RUN_DIR/slices.tsv" ]]; then
    if grep -q '"completed": true' "$RUN_DIR/slices.json"; then
      printf 'archive-cycle: historical archive slices complete; no collection needed\n'
    else
    eligible_now=$(sed -n 's/.*"eligible":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RUN_DIR/slices.json" 2>/dev/null | head -1)
    printf 'archive-cycle: select-slices 选出 0 片（eligible=%s）——采集没有可跑的信源，按失败处理\n' "${eligible_now:-未知}" >&2
    printf 'collect-none\t1\n' >>"$RUN_DIR/exits.tsv"
    CYCLE_RESULT=1
    fi
  fi
  slice_no=0
  while IFS=$'\t' read -r source month quota; do
    [[ -n "$source" ]] || continue
    slice_no=$((slice_no + 1))
    per_month="$PER_MONTH"
    (( quota < per_month )) && per_month=$quota
    COLLECT_ARGS=(scripts/backfill-archive.ts "--source=$source" "--from=$month" "--to=$month" "--max-items=$quota" "--per-month=$per_month" --per-page=100 --sleep=1200 "--min-abstract=$MIN_ABSTRACT")
    run_phase "collect-$slice_no" "${COLLECT_ARGS[@]}" "${WRITE_ARGS[@]}" || CYCLE_RESULT=$?
  done <"$RUN_DIR/slices.tsv"
else
  CYCLE_RESULT=$?
fi
# 出刊成熟度：这一条 2026-10-11 夜加下去、同一夜改成"只报不挡"，理由记在这里免得又被加回来。
# 原意没错：切片是轮转的，某天一结算就当场被印，而同一个月之后还会进来新的档案条目，
# 而 `backfill-papers.ts:155` 默认不重排已出的期次——首版就永久缺那些后来到的条目。
# 但"挡住出刊"这个手段在生产上的代价比它防的问题大，实测（2026-10-12 00:08）：
# 过去 9 个月里每个月都还挂着 pending 切片，共 78 片，而 SLICES=6 × 每 15 分钟一轮 = 24 片/时，
# 一片又要跑几轮才推完（每轮每片只吃 16 条），所以这个数要十几个小时才归零。
# 全月挂账 ⇒ 任何"按月放行"的变体同样会把 1–9 月一起冻住。
# 首版缺后到条目这件事，收尾那一次 `--refresh --apply`（#110）本来就要整体重排一遍，
# 它修的是同一个问题，而且是确定会执行的那一次；所以这里只报数，不拦路。
# 当月不算进去：活页 feed 的切片永远"没跑完"。
PAPERS_RIPE=$(cat <<'NODE'
import { sql, closeDb } from '@aihot/backend/db';
import { beijingDate } from '@aihot/contracts/time';
import { archiveDoorFilter } from '@aihot/backend/sources/archive-site';
const [from,to] = process.argv.slice(1);
try {
  const current = beijingDate(Date.now()).slice(0,7);
  // 谓词与上面 select-slices 那段是**同一个函数**（`sources/archive-site.ts` 的 `archiveDoorFilter`），
  // 不再是"两处手写、注释说它们一致"。停用或丢了 `config.issn` 的信源留下的 pending 行选择器不会再碰，
  // 算进来就是永远报不收敛——那正是加闸门时最该防住的假象。
  const [row] = await sql`SELECT count(*)::int AS n FROM archive_ingest ai
     JOIN sources s ON s.id = ai.source_id
     WHERE ai.status IN ('pending','running') AND ai.month >= ${from.slice(0,7)} AND ai.month <= ${to.slice(0,7)}
       AND ai.month < ${current}
       AND ${archiveDoorFilter(sql`s`)}`;
  console.log((row?.n ?? 0) === 0 ? 'ripe' : `pending:${row?.n ?? 0}`);
} finally { await closeDb(); }
NODE
)
PAPER_ARGS=(scripts/backfill-papers.ts "--from=$FROM" "--to=$TO" --kinds=daily,weekly,monthly "--summary-file=$RUN_DIR/papers.json")
if [[ "$FINAL_REFRESH" == 1 ]]; then PAPER_ARGS+=(--refresh); fi
# 只报不挡：读得出来就报数，读不出来也只是少一行日志。这条判据一旦能拦住出刊，它就迟早会拦住
# 不该拦的那一次（全月挂账、或它自己查询失败），而那正是上面注释里代价比问题更大的形状。
# 但"只报不挡"不等于"沉默"：ripe / pending:N / 读不出来 是三种不同的事实，原先只有第二种会打印，
# 于是"进口已收敛"与"判据连不上库"在日志里长得一模一样——下一轮出事时没人知道该查哪一个。
run_phase papers-ripe --input-type=module -e "$PAPERS_RIPE" "$FROM" "$TO" || true
ripe_state=$(sed -n 's/^\(ripe\|pending:[0-9][0-9]*\)$/\1/p' "$RUN_DIR/papers-ripe.log" 2>/dev/null | head -1)
case "$ripe_state" in
  ripe) printf 'archive-cycle: 过去月份的档案进口已收敛（%s…%s 窗口内 pending=0）\n' "$FROM" "$TO" >&2 ;;
  pending:*) printf 'archive-cycle: 过去月份还有 %s 片档案进口未收敛——本轮照常出刊，首版可能少后到的条目，由收尾的 --refresh 整体重排\n' "${ripe_state#pending:}" >&2 ;;
  *) printf 'archive-cycle: 出刊成熟度判据**没读出来**（papers-ripe.log 末行：%s）——本轮照常出刊，但这一格是"不知道"，不是"已收敛"\n' \
       "$(tail -1 "$RUN_DIR/papers-ripe.log" 2>/dev/null)" >&2 ;;
esac
run_phase papers "${PAPER_ARGS[@]}" "${WRITE_ARGS[@]}" || CYCLE_RESULT=$?

# Rotate a few verified publisher adapters per cycle, within the same lock and deadline.
NEWS_SELECTOR=$(cat <<'NODE'
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { sql, closeDb } from '@aihot/backend/db';
const [stateDir,runDir,doorsArg] = process.argv.slice(1);
try {
  const rules = JSON.parse(readFileSync('industry/news-archives.json','utf8')).archives;
  const enabled = new Set((await sql`SELECT id FROM sources WHERE enabled AND participation_mode='editorial'`).map(x=>x.id));
  const ids = rules.map(x=>x.sourceId).filter(x=>enabled.has(x));
  const doors = Number(doorsArg ?? '1');
  if(!Number.isSafeInteger(doors)||doors<1) throw new Error('Invalid news door count');
  let cursor=0;
  try { cursor=Number(readFileSync(`${stateDir}/next-news`,'utf8').trim()); } catch(e) { if(e.code!=='ENOENT') throw e; }
  if(!Number.isSafeInteger(cursor)||cursor<0) throw new Error('Invalid news cursor');
  // Walk `doors` consecutive entries of the rotation instead of one, so a 50-rule pack is a ~4-hour pass
  // rather than a 12.5-hour one. The cursor advances by what was actually taken, so a pack that shrinks
  // below `doors` still visits every rule without repeating an id inside one round.
  const picked = ids.length ? Array.from({length: Math.min(doors, ids.length)}, (_,k)=>ids[(cursor+k)%ids.length]) : [];
  writeFileSync(`${runDir}/news-source`,picked.join(','));
  writeFileSync(`${stateDir}/next-news.tmp`,String(ids.length?(cursor+picked.length)%ids.length:0));
  renameSync(`${stateDir}/next-news.tmp`,`${stateDir}/next-news`);
} finally { await closeDb(); }
NODE
)
if run_phase select-news --input-type=module -e "$NEWS_SELECTOR" "$STATE_DIR" "$RUN_DIR" "$NEWS_DOORS"; then
  news_source=$(cat "$RUN_DIR/news-source")
  if [[ -n "$news_source" ]]; then
    # 100 条是**每扇门**的上限，所以按门数放大：写成固定 100 的话，三扇门会共享同一道闸，
    # 排在前面的门把额度吃光，后面的门静默饿死——台账里只看得出"这一轮 100 条"，看不出少了谁。
    run_phase collect-news scripts/backfill-news.ts "--sources=$news_source" "--from=$FROM" "--to=$TO" --max-pages=5 "--max-items=$((100 * NEWS_DOORS))" --sleep-ms=1200 "${WRITE_ARGS[@]}" || CYCLE_RESULT=$?
  fi
else
  CYCLE_RESULT=$?
fi
exit "$CYCLE_RESULT"
