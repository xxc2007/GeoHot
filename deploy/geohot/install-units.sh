#!/usr/bin/env bash
# Writes the four long-lived systemd units for the /geohot/ deployment and reloads systemd.
# Written after the first deployment attempt failed on three things, all of which are fixed here:
#   1. the units pointed at a checkout that does not exist — see APP_ROOT below. All four scripts read the
#      one install-path variable (GEOHOT_APP_ROOT); the systemd/*.service templates under deploy/geohot/ are
#      plain text (systemd has no variable interpolation here), so they hard-code the same default and are
#      only correct for that path — bootstrap-server.sh step 10 refuses to install them otherwise.
#   2. every unit needs HOME=/opt/geohot (the geohot account has no login shell) and an absolute
#      --env-file path — a relative one resolves against the unit's own WorkingDirectory and the unit
#      crash-loops with "node: .env: not found";
#   3. each unit carries a MemoryMax so an OOM inside GEOHOT cannot take nginx or Artalk with it —
#      that is the whole point of running a second service on a 900 MB box.
#
# These are the minimal long-lived units — the four processes a reader-visible page needs. The live box
# runs four more (deploy/geohot/systemd/): geohot-workbuddy and geohot-workbuddy-cn (the two bridges that
# together carry most of the judging calls), plus geohot-archive.service and its timer. The templates in
# deploy/geohot/systemd/ are these same four units plus a hardening block (ProtectSystem=strict,
# ReadWritePaths, …) **and** those four extra units, which this script never writes —
# bootstrap-server.sh step 10 installs all eight. Pick one route per box; both read the same
# GEOHOT_APP_ROOT, and both keep the MemoryMax.
#
# Run as a user with sudo. Idempotent: it overwrites the unit files, which is the point.
#
# ★ 2026-10-05 之前：这个脚本没有 dry-run，一跑就直接 `sudo tee` 写
#   /etc/systemd/system/geohot-{brain,api,worker,web}.service 并 `systemctl daemon-reload`，
#   没有开关、也不先备份旧单元。现在默认 DRY-RUN（与同目录三个脚本一个规矩）：不加 `--apply`
#   就只把四个单元打进终端、一行 sudo 都不发；仍然不自动备份，要留底自己跑下面那条 cp。对比：bootstrap-server.sh、fix-bare-path.sh、rollback.sh
#   默认都是 DRY-RUN，要 `--apply` 才动手；verify-deploy.sh 是纯只读。也就是说"先看一眼会发生什么"
#   这件事在本脚本里没有内置，得自己做：
#       sudo systemctl cat geohot-web            # 现状（改之前留个底）
#       sudo cp -a /etc/systemd/system/geohot-*.service /root/units-backup-$(date +%F)/
#   写完确认：systemctl list-units 'geohot-*' 与 systemctl cat <单元> 两处都该看到你预期的
#   APP_ROOT（GEOHOT_APP_ROOT，默认 /opt/geohot/app）与绝对 --env-file 路径。
#   要装"带加固块（ProtectSystem=strict 等）"的那一份，别用本脚本，走 bootstrap-server.sh 第 10 节
#   安装 deploy/geohot/systemd/*.service —— 一台机器只选一条路线，两条都读同一个 GEOHOT_APP_ROOT。
set -euo pipefail
# One install path for the whole deploy package (bootstrap / install-units / verify-deploy / rollback and
# the systemd/ templates all default to this value). Override with GEOHOT_APP_ROOT=/other/path.
APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
APP_HOME="${APP_ROOT%/*}"          # /opt/geohot — HOME= for the units (the geohot account has none)

# 默认 DRY-RUN，和同目录的 bootstrap-server.sh / fix-bare-path.sh / rollback.sh 一个规矩：不加 --apply 就
# 只把四个单元打进终端，一行 sudo 都不发、不碰 /etc/systemd、不 daemon-reload。这台机器上正在跑的东西
# 不会因为"先看一眼"被动到。
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "未知参数: $arg（可用: --apply）" >&2; exit 2 ;;
  esac
done

emit_unit() {
  if [[ $APPLY == 1 ]]; then sudo tee "$1" >/dev/null
  else printf '\n---- 将写入 %s ----\n' "$1"; cat; fi
}

# ★ 2026-10-15：一台机器只该有一条恢复路线。以前这里生成的四个单元**没有加固块**
#   （NoNewPrivileges / PrivateTmp / ProtectSystem=strict / ReadWithPaths / ProtectKernel*…），
#   而 deploy/geohot/systemd/*.service 那份有——两条都在仓库里、都叫"恢复单元"，
#   照哪一条走取决于你跑了哪个脚本，这就是"GitHub 也能随时迁移"这句话里的洞：
#   新机器跑本脚本会静默拿到一套零沙箱的单元（工单 #194 第二条讲的就是它）。
#   现在：默认路径下直接安装 systemd/ 那一份（八个单元齐全、带加固、与线上现值已对齐），
#   只有当 GEOHOT_APP_ROOT 指到别处（模板里 /opt/geohot/app 是写死的，systemd 不做变量插值）
#   才退回下面的生成路线，并且明说退回来的是没有加固块的那一份。
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd"
ALL_UNITS=(geohot-brain.service geohot-api.service geohot-worker.service geohot-web.service
           geohot-workbuddy.service geohot-workbuddy-cn.service geohot-archive.service geohot-archive.timer)
if [[ "$APP_ROOT" == "/opt/geohot/app" && -d "$TEMPLATE_DIR" ]]; then
  echo "route=templates  从 $TEMPLATE_DIR 安装 ${#ALL_UNITS[@]} 个单元（带加固块；这一条与线上现值一致）"
  src_missing=0
  for u in "${ALL_UNITS[@]}"; do
    [[ -f "$TEMPLATE_DIR/$u" ]] || { echo "✗ 模板缺失：$TEMPLATE_DIR/$u"; src_missing=1; }
  done
  (( src_missing )) && exit 2
  for u in "${ALL_UNITS[@]}"; do
    dest="/etc/systemd/system/$u"
    if [[ $APPLY == 1 ]]; then
      if [[ -f "$dest" ]] && ! cmp -s "$TEMPLATE_DIR/$u" "$dest"; then
        sudo cp -a "$dest" "$dest.pre-units-$(date -u +%Y%m%dT%H%M%SZ).bak"
      fi
      sudo cp "$TEMPLATE_DIR/$u" "$dest"
      echo "wrote $u"
    else
      printf '\n---- 将写入 %s（取自 systemd/%s）----\n' "$dest" "$u"
      if [[ -f "$dest" ]]; then diff "$dest" "$TEMPLATE_DIR/$u" | sed 's/^/    /' || true; else cat "$TEMPLATE_DIR/$u"; fi
    fi
  done
  if [[ $APPLY == 0 ]]; then
    echo
    echo "DRY-RUN 结束：上面是将要写进 /etc/systemd/system 的 ${#ALL_UNITS[@]} 个单元（左=线上现值，右=仓库模板）。确认后：bash install-units.sh --apply"
    exit 0
  fi
  sudo systemctl daemon-reload
  missing=()
  for u in "${ALL_UNITS[@]}"; do
    [[ -n "$(systemctl list-unit-files "$u" --no-legend)" ]] || missing+=("$u")
  done
  if (( ${#missing[@]} )); then
    echo "✗ 装完仍缺：${missing[*]}" >&2; exit 1
  fi
  drift=$(bash "$(dirname "${BASH_SOURCE[0]}")/verify-config-drift.sh" | grep -c '^DRIFT:' || true)
  echo "installed ${#ALL_UNITS[@]} units from templates; verify-config-drift 报漂移 $drift 处"
  echo "enable+start with: sudo systemctl enable --now geohot-brain geohot-api geohot-worker geohot-web geohot-workbuddy geohot-workbuddy-cn && sudo systemctl enable --now geohot-archive.timer"
  exit 0
fi
echo "route=generated  GEOHOT_APP_ROOT=$APP_ROOT ≠ /opt/geohot/app，模板里的绝对路径不适用；"
echo "                  下面生成的四个单元**不带加固块**，装完请手工补一份 systemd drop-in 或把仓库模板里的路径改掉。"

# The editorial-brain stub. It is load-bearing here: config.ts:92 defaults MODEL_CALLS_ENABLED to true, so
# a box without this process makes every analysis call against a dead 127.0.0.1:3055 and reports nothing.
# bootstrap-server.sh step 5 writes that valve into .env explicitly; this unit is the other leg of the deal.
emit_unit /etc/systemd/system/geohot-brain.service <<UNIT
[Unit]
Description=GEOHOT editorial brain (local OpenAI-compatible stub, 127.0.0.1:3055)
After=network.target

[Service]
User=geohot
Group=geohot
WorkingDirectory=$APP_ROOT
EnvironmentFile=$APP_ROOT/.env
Environment=NODE_ENV=production
Environment=AIHOT_ENVIRONMENT=production
Environment=HOME=$APP_HOME
Environment=BRAIN_PORT=3055
MemoryMax=160M
MemorySwapMax=400M
ExecStart=/usr/bin/node tooling/brain-stub.ts
Restart=on-failure
RestartSec=5
# The worker drains in-flight jobs on stop; systemd's 90 s default SIGKILLs mid-drain, which is the
# outcome-unknown path (a job that ran but never recorded). Give every unit the worker's budget:
# STOP_TIMEOUT_MS = 255 s, itself longer than one reasoning call (240 s in providers/llm.ts) + margin.
TimeoutStopSec=285

[Install]
WantedBy=multi-user.target
UNIT

for n in api worker web; do
  wd="$APP_ROOT"; [ "$n" = web ] && wd="$APP_ROOT/apps/web"
  max=240M; [ "$n" = web ] && max=320M; [ "$n" = api ] && max=200M
  case "$n" in
    api)    tag="GEOHOT api (Fastify, 127.0.0.1:3001)"; exec="/usr/bin/node --env-file=.env apps/api/src/main.ts"; after="postgresql.service geohot-brain.service"; host="Environment=API_HOST=127.0.0.1";;
    worker) tag="GEOHOT worker (pg-boss queues + schedules; SINGLE INSTANCE ONLY)"; exec="/usr/bin/node --env-file=.env apps/worker/src/main.ts"; after="postgresql.service geohot-brain.service"; host="";;
    web)    tag="GEOHOT web (SSR, 127.0.0.1:3000)"; exec="/usr/bin/node --env-file=$APP_ROOT/.env server.ts"; after="geohot-api.service"; host="Environment=WEB_HOST=127.0.0.1";;
  esac
  # No BASE_PATH here on purpose: apps/web/server.ts:46-49 takes the prefix from the built bundle, so a
  # runtime Environment=BASE_PATH= line is inert — editing it and restarting changes nothing. The prefix is
  # a build-time variable (bootstrap-server.sh step 9: BASE_PATH='${GEOHOT_BASE_PATH}' npm run build).
  emit_unit "/etc/systemd/system/geohot-$n.service" <<UNIT
[Unit]
Description=$tag
After=network.target $after

[Service]
User=geohot
Group=geohot
WorkingDirectory=$wd
EnvironmentFile=$APP_ROOT/.env
Environment=NODE_ENV=production
Environment=AIHOT_ENVIRONMENT=production
Environment=HOME=$APP_HOME
Environment=TZ=Asia/Shanghai
$host
MemoryMax=$max
MemorySwapMax=600M
ExecStart=$exec
Restart=on-failure
RestartSec=5
# The worker drains in-flight jobs on stop; systemd's 90 s default SIGKILLs mid-drain, which is the
# outcome-unknown path (a job that ran but never recorded). Give every unit the worker's budget:
# STOP_TIMEOUT_MS = 255 s, itself longer than one reasoning call (240 s in providers/llm.ts) + margin.
TimeoutStopSec=285

[Install]
WantedBy=multi-user.target
UNIT
done

if [[ $APPLY == 0 ]]; then
  echo
  echo "DRY-RUN 结束：上面就是将要写进 /etc/systemd/system 的四个单元。确认后：bash install-units.sh --apply"
  exit 0
fi
sudo systemctl daemon-reload
# 装完要逐个点名核对。两版都不行：
# · 以前只把数量打给人看，"写了三个、少一个"也能一路走到 enable——少的那个进程不会报错，
#   只是那条链路静默停摆（少 geohot-brain 就是每一次分析都打到没人听的端口）。
# · 改成 `!= 4` 之后又错在另一头：这台机器上现在装的是 8 个 geohot-* 单元
#   （workbuddy 桥 + archive 的 .service/.timer 都由 systemd/ 模板装），
#   拿全局计数当"本脚本的四个装齐了没"的判据，在真机上必然报 ✗。
missing=()
for n in geohot-brain.service geohot-api.service geohot-worker.service geohot-web.service; do
  [[ -n "$(systemctl list-unit-files "$n" --no-legend)" ]] || missing+=("$n")
done
installed=$(systemctl list-unit-files 'geohot*' --no-legend | wc -l)
echo "installed: $installed units on this box (this script writes 4, APP_ROOT=$APP_ROOT)"
if (( ${#missing[@]} )); then
  echo "✗ 本脚本该装的单元里缺：${missing[*]} —— 已有的 geohot-* 单元："
  systemctl list-unit-files 'geohot*' --no-legend
  exit 1
fi
echo "the site prefix is baked into the web bundle — rebuild with BASE_PATH if it changes, do not edit these units"
echo "enable+start with: sudo systemctl enable --now geohot-brain geohot-api geohot-worker geohot-web"
