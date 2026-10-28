#!/bin/bash
# Reviewed source-only repair. No frontend build, provider probes, receipt edits or concurrency changes.
set -euo pipefail
cd /opt/geohot/app
backup=/opt/geohot/backups/reader-complete-policy-20261028
candidate=/opt/geohot/reader-complete-policy-candidate-20261028
manifest=/tmp/reader-complete-manifest.json
owner=/var/lib/geohot-maintenance/worker-owner.json
mkdir -p "$backup" "$candidate" /var/lib/geohot-maintenance
[ ! -e "$backup/source-before.tar" ]
tar -xf /tmp/reader-complete-candidate.tar -C "$candidate"
verify(){ python3 - <<'PY'
import json,pathlib,hashlib
root=pathlib.Path('/opt/geohot/app');candidate=pathlib.Path('/opt/geohot/reader-complete-policy-candidate-20261028')
for r in json.load(open('/tmp/reader-complete-manifest.json')):
 p=root/r['file'];assert (hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None)==r['baselineSha256'],'Concurrent edit: '+r['file']
 assert hashlib.sha256((candidate/r['file']).read_bytes()).hexdigest()==r['sha256'],r['file']
print('Source CAS verified')
PY
}
verify
[ ! -e /run/geohot-r115-gate ] && [ ! -e /etc/geohot/r115-gate.disarmed ] && [ ! -e "$owner" ]
systemctl is-active --quiet geohot-worker
copied=0; api_restarted=0
restore(){
 rc=$?
 if [ "$rc" != 0 ] && [ "$copied" = 1 ];then
  tar -xf "$backup/source-before.tar"
  if [ "$api_restarted" = 1 ];then systemctl restart geohot-api;fi
  if [ -f "$backup/cache-before.conf" ];then cp "$backup/cache-before.conf" /etc/nginx/snippets/geohot-public-cache.conf;nginx -t && systemctl reload nginx;fi
  echo 'Previous source restored; additional schema columns retained for compatible rollback'
 fi
 python3 - <<'PY'
import pathlib,json
p=pathlib.Path('/var/lib/geohot-maintenance/worker-owner.json')
if p.exists() and json.loads(p.read_text()).get('owner')=='reader-complete-policy-20261028':p.unlink()
PY
 if [ ! -e "$owner" ] && [ ! -e /run/geohot-r115-gate ] && [ ! -e /etc/geohot/r115-gate.disarmed ];then systemctl start --no-block geohot-worker;fi
 exit "$rc"
}
python3 - <<'PY'
import os
f=os.open('/var/lib/geohot-maintenance/worker-owner.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(f,b'{"owner":"reader-complete-policy-20261028"}');os.close(f)
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
rows=json.load(open('/tmp/reader-complete-manifest.json'))
subprocess.run(['tar','-cf','/opt/geohot/backups/reader-complete-policy-20261028/source-before.tar',*[r['file'] for r in rows if r['deploy'] and r['baselineSha256']]],check=True)
shutil.copyfile('/tmp/reader-complete-manifest.json','/opt/geohot/backups/reader-complete-policy-20261028/manifest.json')
PY
sudo -u geohot env DATABASE_POOL_MAX=1 node --env-file=.env --input-type=module <<'JS'
import fs from 'node:fs';import postgres from 'postgres';
const s=postgres(process.env.DATABASE_URL,{max:1,connection:{statement_timeout:5000,lock_timeout:1000}});
try{await s.begin(async t=>{
 const prerequisites=await t`SELECT name FROM schema_migrations WHERE name IN ('0091_article_media_readiness.sql','0092_workflow_readiness_projection.sql')`;
 if(prerequisites.length!==2)throw Error('Readiness migration prerequisites missing');
 const [prior]=await t`SELECT name FROM schema_migrations WHERE name='0095_reader_complete_policy.sql'`;
 if(!prior){await t.unsafe(fs.readFileSync('/opt/geohot/reader-complete-policy-candidate-20261028/database/migrations/0095_reader_complete_policy.sql','utf8'));await t`INSERT INTO schema_migrations(name) VALUES('0095_reader_complete_policy.sql')`;}
});console.log('Reader policy schema ready');}finally{await s.end()}
JS
copied=1
python3 - <<'PY'
import json,pathlib,shutil
for r in json.load(open('/tmp/reader-complete-manifest.json')):
 if not r['deploy']:continue
 p=pathlib.Path(r['file']);p.parent.mkdir(parents=True,exist_ok=True)
 shutil.copyfile(pathlib.Path('/opt/geohot/reader-complete-policy-candidate-20261028')/p,p);shutil.chown(p,'geohot','geohot')
PY
# End the old API writer before any policy-2 facts are generated.
api_restarted=1
systemctl restart geohot-api
ok=0
for attempt in $(seq 1 15);do if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3001/api/health;then ok=1;break;fi;sleep 2;done
[ "$ok" = 1 ]
for scope in selected all;do
 args=();[ "$scope" != selected ] || args=(--selected)
 systemd-run --quiet --wait --pipe --collect --unit="geohot-reader-policy-$scope-20261028" -p User=geohot -p WorkingDirectory=/opt/geohot/app -p MemoryMax=100M -p CPUQuota=50% -p Nice=10 /usr/bin/env GEOHOT_RESOURCE_PROFILE=balanced DATABASE_POOL_MAX=1 /usr/bin/node --env-file=.env scripts/refresh-workflow-readiness.ts "${args[@]}" --rounds=4
done
cp /etc/nginx/snippets/geohot-public-cache.conf "$backup/cache-before.conf"
python3 - <<'PY'
import pathlib
p=pathlib.Path('/etc/nginx/snippets/geohot-public-cache.conf');s=p.read_text()
assert 'workflow-ready-v4:' in s,'Unexpected cache version; inspect before updating'
p.write_text(s.replace('workflow-ready-v4:','reader-complete-v2:'))
PY
nginx -t
systemctl reload nginx
python3 - <<'PY'
import json,pathlib,hashlib
rows=json.load(open('/tmp/reader-complete-manifest.json'))
for r in rows:assert hashlib.sha256(pathlib.Path(r['file']).read_bytes()).hexdigest()==r['sha256'],r['file']
print('All controlled sources verified:',len(rows))
PY
echo 'Reader policy switched; worker restoration remains owned by this trap or R115'
date -Is
