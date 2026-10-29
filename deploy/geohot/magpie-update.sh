#!/bin/bash
set -euo pipefail
exec 9>/run/lock/geohot-magpie-update.lock
flock -n 9 || exit 0
# Share the same atomic exclusion as workstation extraction and source releases.
owner=/var/lib/geohot-maintenance/worker-owner.json
if ! python3 - "$owner" "$$" <<'PY'
import os,json,sys
try:fd=os.open(sys.argv[1],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
except FileExistsError:sys.exit(1)
with os.fdopen(fd,'w') as f:json.dump({'owner':'magpie-update','pid':sys.argv[2]},f)
PY
then
 echo 'Magpie update deferred: another maintenance or workstation session owns the fence'
 exit 0
fi
finish_owner(){
 python3 - "$owner" "$$" <<'PY'
import pathlib,json,sys
p=pathlib.Path(sys.argv[1])
if p.exists():
 row=json.loads(p.read_text())
 if row.get('owner')=='magpie-update' and row.get('pid')==sys.argv[2]:p.unlink()
PY
}
trap finish_owner EXIT
bin=/usr/local/bin/geohot-magpie
home=/var/lib/geohot-magpie
backup=/var/lib/geohot-magpie-update
install -d -m 700 "$backup"
cp -p "$bin" "$backup/binary-before"
before=$(sha256sum "$bin" | cut -d' ' -f1)
# The official updater verifies the vendor's published SHA-256; never run downloaded shell code.
HOME="$home" "$bin" update >"$backup/update.log" 2>&1
after=$(sha256sum "$bin" | cut -d' ' -f1)
if [[ "$before" != "$after" ]]; then
 systemctl restart geohot-magpie.service
 ok=0
 for n in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3426/v1/models >/dev/null; then ok=1;break;fi
  sleep 2
 done
 if [[ "$ok" != 1 ]]; then
  cp -p "$backup/binary-before" "$bin"
  systemctl restart geohot-magpie.service
  echo 'Magpie update failed health check; previous binary restored' >&2
  exit 1
 fi
fi
HOME="$home" "$bin" --version >"$home/version.txt" 2>/dev/null
chown geohot-magpie:geohot-magpie "$home/version.txt"
echo "Magpie official update check completed: $(date -Is)"
