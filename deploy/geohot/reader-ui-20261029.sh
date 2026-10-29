#!/bin/bash
# Reviewed source + off-host web build release. No server build, provider probes or concurrency increases.
set -euo pipefail
cd /opt/geohot/app
backup=/opt/geohot/backups/reader-ui-20261029
candidate=/opt/geohot/reader-ui-candidate-20261029
manifest=/tmp/reader-ui-manifest.json
owner=/var/lib/geohot-maintenance/worker-owner.json
mkdir -p "$backup" "$candidate" /var/lib/geohot-maintenance
[ ! -e "$backup/source-before.tar" ]
tar -xf /tmp/reader-ui-source.tar -C "$candidate"
verify(){ python3 - <<'PY'
import json,pathlib,hashlib
root=pathlib.Path('/opt/geohot/app');candidate=pathlib.Path('/opt/geohot/reader-ui-candidate-20261029')
for r in json.load(open('/tmp/reader-ui-manifest.json')):
 p=root/r['file'];assert (hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None)==r['baselineSha256'],'Concurrent edit: '+r['file']
 assert hashlib.sha256((candidate/r['file']).read_bytes()).hexdigest()==r['sha256'],r['file']
print('Source CAS verified')
PY
}
verify
[ ! -e /run/geohot-r115-gate ] && [ ! -e /etc/geohot/r115-gate.disarmed ] && [ ! -e "$owner" ]
systemctl is-active --quiet geohot-worker
copied=0; api_restarted=0; build_switched=0
restore(){
 rc=$?
 if [ "$rc" != 0 ] && [ "$copied" = 1 ];then
  tar -xf "$backup/source-before.tar"
  if [ "$build_switched" = 1 ];then if [ -d apps/web/build ];then mv apps/web/build "$candidate/failed-build";fi;mv "$backup/web-build" apps/web/build;systemctl restart geohot-web;fi
  if [ "$api_restarted" = 1 ];then systemctl restart geohot-api;fi
  if [ -f "$backup/cache-before.conf" ];then cp "$backup/cache-before.conf" /etc/nginx/snippets/geohot-public-cache.conf;nginx -t && systemctl reload nginx;fi
  echo 'Previous source restored; additional schema columns retained for compatible rollback'
 fi
 python3 - <<'PY'
import pathlib,json
p=pathlib.Path('/var/lib/geohot-maintenance/worker-owner.json')
if p.exists() and json.loads(p.read_text()).get('owner')=='reader-ui-20261029':p.unlink()
PY
 if [ ! -e "$owner" ] && [ ! -e /run/geohot-r115-gate ] && [ ! -e /etc/geohot/r115-gate.disarmed ];then systemctl start --no-block geohot-worker;fi
 exit "$rc"
}
python3 - <<'PY'
import os
f=os.open('/var/lib/geohot-maintenance/worker-owner.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(f,b'{"owner":"reader-ui-20261029"}');os.close(f)
PY
trap restore EXIT
# Let in-flight paid work persist; never force kill or clear unknown receipts.
systemctl stop geohot-worker
[ "$(systemctl show geohot-worker -p Result --value)" = success ]
healthy=0
for attempt in $(seq 1 12);do
 if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -ge 131072 ] && awk '/^full / {split($2,a,"=");ok=(a[2]<10)} END {exit !ok}' /proc/pressure/memory && awk '/^full / {split($2,a,"=");ok=(a[2]<30)} END {exit !ok}' /proc/pressure/io;then healthy=1;break;fi
 sleep 5
done
[ "$healthy" = 1 ] || { echo 'Resource gate deferred deployment';exit 1; }
[ ! -e /run/geohot-r115-gate ] && [ ! -e /etc/geohot/r115-gate.disarmed ]
verify
python3 - <<'PY'
import json,subprocess,shutil
rows=json.load(open('/tmp/reader-ui-manifest.json'))
subprocess.run(['tar','-cf','/opt/geohot/backups/reader-ui-20261029/source-before.tar',*[r['file'] for r in rows if r['deploy'] and r['baselineSha256']]],check=True)
shutil.copyfile('/tmp/reader-ui-manifest.json','/opt/geohot/backups/reader-ui-20261029/manifest.json')
PY
# Database migrations 0095/0096 were deployed by the preceding reviewed policy release.
tar -xf /tmp/reader-ui-build.tar -C "$candidate"
python3 - <<'PY'
import json,pathlib,hashlib
root=pathlib.Path('/opt/geohot/reader-ui-candidate-20261029')
for r in json.load(open('/tmp/reader-ui-build-manifest.json')):assert hashlib.sha256((root/r['file']).read_bytes()).hexdigest()==r['sha256'],r['file']
PY

copied=1
python3 - <<'PY'
import json,pathlib,shutil
for r in json.load(open('/tmp/reader-ui-manifest.json')):
 if not r['deploy']:continue
 p=pathlib.Path(r['file']);p.parent.mkdir(parents=True,exist_ok=True)
 shutil.copyfile(pathlib.Path('/opt/geohot/reader-ui-candidate-20261029')/p,p);shutil.chown(p,'geohot','geohot')
PY
# End the old API writer before any current-policy facts are generated.
api_restarted=1
systemctl restart geohot-api
ok=0
for attempt in $(seq 1 15);do if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3001/api/health;then ok=1;break;fi;sleep 2;done
[ "$ok" = 1 ]
for scope in reports;do
 args=(--reports)
 systemd-run --quiet --wait --pipe --collect --unit="geohot-reader-ui-$scope-20261029" -p User=geohot -p WorkingDirectory=/opt/geohot/app -p MemoryMax=100M -p CPUQuota=50% -p Nice=10 /usr/bin/env GEOHOT_RESOURCE_PROFILE=balanced DATABASE_POOL_MAX=1 /usr/bin/node --env-file=.env scripts/refresh-workflow-readiness.ts "${args[@]}" --rounds=8
done
# Keep immutable old assets reachable by previously cached pages, then switch the build atomically.
cp -an apps/web/build/client/assets/. "$candidate/apps/web/build/client/assets/"
chown -R geohot:geohot "$candidate/apps/web/build"
mv apps/web/build "$backup/web-build"
build_switched=1
mv "$candidate/apps/web/build" apps/web/build
systemctl restart geohot-web
curl --fail --silent --max-time 15 http://127.0.0.1:3000/geohot/ -o /dev/null
cp /etc/nginx/snippets/geohot-public-cache.conf "$backup/cache-before.conf"
python3 - <<'PY'
import pathlib
p=pathlib.Path('/etc/nginx/snippets/geohot-public-cache.conf');s=p.read_text()
assert 'reader-complete-v3:' in s,'Unexpected cache version; inspect before updating'
p.write_text(s.replace('reader-complete-v3:','reader-ui-v1:'))
PY
nginx -t
systemctl reload nginx
python3 - <<'PY'
import json,pathlib,hashlib
rows=json.load(open('/tmp/reader-ui-manifest.json'))
for r in rows:assert hashlib.sha256(pathlib.Path(r['file']).read_bytes()).hexdigest()==r['sha256'],r['file']
print('All controlled sources verified:',len(rows))
PY
echo 'Reader policy switched; worker restoration remains owned by this trap or R115'
date -Is
