#!/bin/bash
# InstaBox 上的自举脚本：机器每次启动后把执行器装回去。
#
# 为什么需要它：InstaBox 免费档「根盘」可能被模板重置，只有 /data 是持久盘。
# 所以把 env 与两个单元留在 /data/geohot-boot/ 下，开机/被主库叫醒后重放这一份。
#
# 用法（机器上，root）：
#   sudo /data/geohot-boot/bootstrap.sh
# 主库的 geohot-instabox-hold.service 会在机器醒来的第一轮调用它，所以平时不用手工跑。
set -euo pipefail

SRC=${INSTABOX_BOOT_DIR:-/data/geohot-boot}

install -d -m 755 /opt/geohot-exec
install -m 600 -o root -g root "$SRC/exec.env" /opt/geohot-exec/.env
install -m 644 "$SRC/geohot-exec-tunnel.service" /etc/systemd/system/geohot-exec-tunnel.service
install -m 644 "$SRC/geohot-exec-worker.service" /etc/systemd/system/geohot-exec-worker.service
systemctl daemon-reload
systemctl enable --now geohot-exec-tunnel.service geohot-exec-worker.service

sleep 3
line="$(date -Is) boot ok tunnel=$(systemctl is-active geohot-exec-tunnel.service) worker=$(systemctl is-active geohot-exec-worker.service)"
echo "$line" >> "$SRC/boot.log"
echo "$line"
