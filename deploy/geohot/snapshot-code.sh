#!/usr/bin/env bash
# 上线前的代码快照：把应用目录打包，但不把和代码并排放着的密钥一起打包。
# 恢复时密钥由 `.env` 自己那一份负责（见 DEPLOYMENT.md 的恢复步骤），所以它不该出现在这个包里。
set -Eeuo pipefail
umask 077

APP_ROOT="${GEOHOT_APP_ROOT:-/opt/geohot/app}"
OUT_DIR="${GEOHOT_BACKUP_DIR:-/opt/geohot/backups}"
NAME="${1:-app-$(date +%Y%m%d-%H%M%S).tar.gz}"

fail() { printf 'snapshot-code: %s\n' "$1" >&2; exit 2; }
# 只判"这个目录在不在"，不判它写得像不像 Unix 绝对路径：本机用临时目录跑这条判据时给的是
# `C:\Users\…` 这种形式，被 `/*` 一筛就成了假红。
[[ -d "$APP_ROOT" ]] || fail "应用目录不存在：$APP_ROOT"
[[ "$NAME" != */* && "$NAME" != *\\* && -n "$NAME" ]] || fail '包名不能带路径'
command -v tar >/dev/null || fail '找不到 tar'

# --exclude 是按「存进包里的成员名」匹配的，而 `-C <父目录> app` 存的是 `app/.env` 这种形式：
# 带 `./` 前缀的模式在这种写法下一条都不会命中。文档里那条一行命令就是因为这个，连着三天把 `.env`
# 打进了备份（2026-10-11 用 GNU tar 1.35 复现：`--exclude=./app/.env` 打完仍有 `app/.env`）。
# 前缀取自 APP_ROOT 的目录名，所以本机拿一个临时目录也能测。
PARENT="$(dirname "$APP_ROOT")"
LEAF="$(basename "$APP_ROOT")"
mkdir -p "$OUT_DIR"
# 进目录再写包，两个原因：`tar -czf C:/…` 会被 GNU tar 当成远程主机（`Cannot connect to C: resolve failed`），
# 以及 `-C "$PARENT" "$LEAF"` 存出来的成员名必须以目录名为前缀，exclude 模式才有得匹配。
LISTING="$(cd "$OUT_DIR" && tar --exclude="$LEAF/.env" --exclude="$LEAF/.env.pipeline" \
  --exclude="$LEAF/.env.bak*" --exclude="$LEAF/.data" -czf "$NAME" -C "$PARENT" "$LEAF" && tar tzf "$NAME")" \
  || fail "打包失败：$OUT_DIR/$NAME"
# 打包成功不等于排除成功，所以按结果判一次；命中就把包删掉再报错，免得留下一个看起来正常的泄密包。
if printf '%s\n' "$LISTING" | grep -Eq "(^|/)\.env$|(^|/)\.env\.(pipeline|bak)|(^|/)\.data/"; then
  rm -f "$OUT_DIR/$NAME"
  fail '包里仍然含有 .env 或 .data，已删除该包'
fi
printf 'snapshot-code: %s 个成员 → %s/%s（不含 .env*、.data）\n' "$(printf '%s\n' "$LISTING" | wc -l)" "$OUT_DIR" "$NAME"
