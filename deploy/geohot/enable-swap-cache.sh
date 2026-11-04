#!/bin/bash
# Use spare CPU for a bounded compressed swap cache; keep the existing disk swap as fallback.
set -eu
p=/sys/module/zswap/parameters
test -w "$p/enabled"
if /sbin/modprobe zsmalloc 2>/dev/null; then printf 'zsmalloc\n' > "$p/zpool"; fi
printf '10\n' > "$p/max_pool_percent"
printf 'Y\n' > "$p/enabled"
test "$(cat "$p/enabled")" = Y
test "$(cat "$p/max_pool_percent")" = 10
printf 'bounded swap cache: enabled=%s pool=%s limit=%s%%\n' "$(cat "$p/enabled")" "$(cat "$p/zpool")" "$(cat "$p/max_pool_percent")"
