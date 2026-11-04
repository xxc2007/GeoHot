#!/usr/bin/env python3
"""Read-only, no credentials: current release/resource admission for a finite PC helper."""
import base64 as _b64
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request
import importlib.util
sys.dont_write_bytecode = True


root = pathlib.Path('/opt/geohot/app')
# 读一次输入：默认 stdin（因此每次调用一条连接）；设了 GEOHOT_PROBE_INPUT_B64 就从环境读，
# 这样 supervisor 可以用**一条** SSH 会话在服务端循环采样，而不是每 10 秒新开一条——
# 后者会把 ufw 的 22/tcp LIMIT 打满，之后连上来就是 `Connection timed out`（2026-11-04 现场）。
_raw_b64 = os.environ.get('GEOHOT_PROBE_INPUT_B64')
if _raw_b64:
    request = json.loads(_b64.b64decode(_raw_b64).decode('utf-8'))
else:
    request = json.load(sys.stdin)
session = request.get('session') if isinstance(request, dict) else None
manifest = request.get('manifest') if isinstance(request, dict) else request
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

owner = pathlib.Path('/var/lib/geohot-maintenance/worker-owner.json')
own_session = False
# 导入 fence 只为复用它的 ownership/staleness 判据：本探针原先只把"文件存在"当成维护占用，
# 于是一个被杀掉的会话留下的 worker-owner.json 会把本机辅助永久拒在门外（2026-11-03 16:24
# 那份就是这样挡到 11-04 的）。stale 的判定规则写在 fence 里，两边必须是同一个。
spec = importlib.util.spec_from_file_location('assist_fence', root / 'deploy/geohot/assist-maintenance-fence.py')
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)
if session:
    own_session = fence.owned(owner, session)
stale_owner = fence.stale(owner)
print(json.dumps({
    'at': int(time.time() * 1000), 'remoteFreeMiB': mem, 'memoryFull': psi('memory'), 'ioFull': psi('io'),
    'sourceMatches': matches, 'apiHealthy': healthy,
    'workerAll': unit('ActiveState') == 'active' and worker_env.get(b'WORKER_ROLE', b'all') == b'all',
    'maintenance': owner.exists() and not own_session and not stale_owner,
    'fenceOwned': own_session,
    'r115': pathlib.Path('/run/geohot-r115-gate').exists() or pathlib.Path('/etc/geohot/r115-gate.disarmed').exists()
}))
