#!/usr/bin/env python3
"""Read-only, no credentials: current release/resource admission for a finite PC helper."""
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

root = pathlib.Path('/opt/geohot/app')
manifest = json.load(sys.stdin)
if not isinstance(manifest, list) or not 1 <= len(manifest) <= 1000:
    raise ValueError('invalid manifest')
matches = True
for row in manifest:
    name = row['file']
    if not isinstance(name, str) or '..' in pathlib.PurePosixPath(name).parts or name.startswith('/'):
        raise ValueError('invalid manifest path')
    if not name.startswith(('apps/worker/src/', 'packages/backend/src/', 'packages/contracts/src/', 'industry/')) and name != 'package-lock.json':
        raise ValueError('manifest scope')
    file = root / name
    if not file.is_file() or hashlib.sha256(file.read_text(encoding='utf8').replace('\r\n', '\n').encode()).hexdigest() != row['sha256']:
        matches = False

def unit(field):
    return subprocess.check_output(['systemctl', 'show', 'geohot-worker', '-p', field, '--value'], text=True, timeout=3).strip()

pid = int(unit('MainPID'))
worker_env = dict(item.split(b'=', 1) for item in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item) if pid else {}
mem = next(int(line.split()[1]) / 1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))

def psi(kind):
    line = next(line for line in pathlib.Path('/proc/pressure/' + kind).read_text().splitlines() if line.startswith('full '))
    return float(dict(item.split('=') for item in line.split()[1:])['avg10'])

try:
    with urllib.request.urlopen('http://127.0.0.1:3001/api/health', timeout=2) as response:
        healthy = response.status == 200
except Exception:
    healthy = False

print(json.dumps({
    'at': int(time.time() * 1000), 'remoteFreeMiB': mem, 'memoryFull': psi('memory'), 'ioFull': psi('io'),
    'sourceMatches': matches, 'apiHealthy': healthy,
    'workerAll': unit('ActiveState') == 'active' and worker_env.get(b'WORKER_ROLE', b'all') == b'all',
    'maintenance': pathlib.Path('/var/lib/geohot-maintenance/worker-owner.json').exists(),
    'r115': pathlib.Path('/run/geohot-r115-gate').exists() or pathlib.Path('/etc/geohot/r115-gate.disarmed').exists()
}))
