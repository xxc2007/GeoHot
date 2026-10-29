#!/usr/bin/env python3
"""Server-only, reader-first Magpie maintenance with persistent recovery ownership."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/var/lib/geohot-maintenance')
OWNER = ROOT / 'worker-owner.json'
BIN = Path('/usr/local/bin/geohot-magpie')
CONFIG = Path('/var/lib/geohot-magpie/.config/magpie')
GATE = Path('/run/geohot-r115-gate')
DISARM = Path('/etc/geohot/r115-gate.disarmed')

def command(args, timeout=15, **kwargs):
    return subprocess.run(args, check=True, timeout=timeout, text=True, **kwargs)

def active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0

def resources(memory=180):
    try:
        mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        if int(mem['MemAvailable'].split()[0]) < memory * 1024:
            return False
        for kind, cap in [('memory', 2), ('io', 10), ('cpu', 25)]:
            row = next(x for x in Path('/proc/pressure/' + kind).read_text().splitlines()
                       if x.startswith('some ' if kind == 'cpu' else 'full '))
            if float(row.split()[1].split('=')[1]) >= cap:
                return False
        return shutil.disk_usage('/opt/geohot').free >= 3 * 1024**3
    except (OSError, ValueError, KeyError, StopIteration):
        return False

def health(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200
    except Exception:
        return False

def reader_ready():
    return health('http://127.0.0.1:3000/geohot/') and health('http://127.0.0.1:3001/api/health')

def owns_maintenance(state):
    # Accept only our tagged state or the exact legacy maintenance shape.
    return (isinstance(state, dict) and type(state.get('workerWasActive')) is bool
            and type(state.get('at')) is int
            and (state.get('owner') == 'magpie-update' or 'owner' not in state))

def recover():
    if not OWNER.exists():
        return True
    state = json.loads(OWNER.read_text())
    if not owns_maintenance(state):
        print('maintenance recovery deferred: foreign owner', flush=True)
        return False
    if GATE.exists() or DISARM.exists():
        print('maintenance recovery deferred: reader gate/operator owns the stop', flush=True)
        return False
    # A reboot/kill after replacement may skip update()'s finally block. Only
    # restore our exact recorded candidate; never overwrite a later operator release.
    if not health('http://127.0.0.1:3426/v1/models'):
        backup = ROOT / 'binary-before'
        if (state.get('installedHash') and resources(112) and backup.is_file()
                and digest(BIN) == state['installedHash']
                and digest(backup) == state.get('previousHash')):
            target = BIN.with_name('geohot-magpie.new')
            shutil.copy2(backup, target)
            os.replace(target, BIN)
            command(['systemctl', 'restart', '--no-block', 'geohot-magpie'], timeout=15)
            print('interrupted maintenance: previous gateway restored', flush=True)
            if not health('http://127.0.0.1:3426/v1/models'):
                return False
        else:
            print('maintenance recovery deferred: gateway unavailable or candidate changed', flush=True)
            return False
    if not state.get('workerWasActive'):
        OWNER.unlink()
        return True
    if not resources(112) or not reader_ready() or not health('http://127.0.0.1:3426/v1/models'):
        print('maintenance recovery deferred: services or resources not ready', flush=True)
        return False
    command(['systemctl', 'start', 'geohot-worker'], timeout=30)
    if not active('geohot-worker'):
        return False
    OWNER.unlink()
    print('maintenance-owned worker restored', flush=True)
    return True

def quiet_traffic(now):
    # Bound the read to the last 1000 lines; parse the nginx timestamp including its timezone.
    from datetime import datetime
    lines = subprocess.check_output(['tail', '-n', '1000', '/var/log/nginx/access.log'], text=True).splitlines()
    recent = 0
    saw = False
    for line in lines:
        try:
            timestamp = datetime.strptime(line.split('[', 1)[1].split(']', 1)[0], '%d/%b/%Y:%H:%M:%S %z').timestamp()
            age = now - timestamp
            if age < -5:
                return False
            saw = True
            if age <= 60 and '/geohot' in line:
                recent += 1
        except (ValueError, IndexError):
            continue
    return saw and recent <= 10

def idle():
    return (3 <= time.localtime().tm_hour < 6 and not GATE.exists() and not DISARM.exists()
            and not OWNER.exists() and resources() and reader_ready()
            and not active('geohot-archive') and quiet_traffic(time.time()))

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(stream.read()).hexdigest()

def update():
    if not idle():
        print('DEFER: outside quiet window, reader traffic, protection or resource pressure', flush=True)
        return
    # Require two quiet samples before downloading or stopping any business process.
    time.sleep(20)
    if not idle():
        print('DEFER: idle window did not persist', flush=True)
        return
    stage = ROOT / 'staged-magpie'
    backup = ROOT / 'binary-before'
    shutil.copy2(BIN, stage)
    env = {**os.environ, 'HOME': '/var/lib/geohot-magpie'}
    # Official updater verifies the release checksum. Run against a staged executable.
    with (ROOT / 'update.log').open('w') as log:
        command([str(stage), 'update'], timeout=420, env=env, stdout=log, stderr=subprocess.STDOUT)
    if digest(stage) == digest(BIN):
        stage.unlink()
        print('Magpie already current', flush=True)
        return
    if not idle():
        stage.unlink()
        print('DEFER: download complete; installation postponed', flush=True)
        return
    shutil.copy2(BIN, backup)
    snapshot = ROOT / 'config-before'
    snapshot.mkdir(mode=0o700, exist_ok=True)
    # Recovery evidence stays on this server; do not copy account credentials to a client.
    for name in ['settings.json', 'plugin-auth.json', 'plugins.json', 'plugins.yml', 'logins.json', 'providers.json', 'migrations.json']:
        if (CONFIG / name).is_file():
            shutil.copy2(CONFIG / name, snapshot / name)
    state = {'owner': 'magpie-update', 'workerWasActive': active('geohot-worker'), 'at': int(time.time())}
    tmp = OWNER.with_suffix('.tmp')
    try:
        fd = os.open(OWNER, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        stage.unlink(missing_ok=True)
        print('DEFER: maintenance or workstation owns the fence', flush=True)
        return
    with os.fdopen(fd, 'w') as stream:
        json.dump(state, stream)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        # Existing 300-second stop window preserves in-flight paid-call receipts.
        if state['workerWasActive']:
            command(['systemctl', 'stop', 'geohot-worker'], timeout=330)
        if GATE.exists() or DISARM.exists() or not reader_ready() or not resources(112):
            print('DEFER: safety changed while draining', flush=True)
            return
        connections = subprocess.check_output(['ss', '-Htn', 'state', 'established', '( sport = :3426 )'], text=True)
        if connections.strip():
            print('DEFER: gateway still has established requests', flush=True)
            return
        # Atomic replacement avoids truncating the running gateway executable.
        state.update(installedHash=digest(stage), previousHash=digest(backup))
        tmp.write_text(json.dumps(state))
        os.replace(tmp, OWNER)
        target = BIN.with_name('geohot-magpie.new')
        shutil.copy2(stage, target)
        os.replace(target, BIN)
        try:
            command(['systemctl', 'restart', 'geohot-magpie'], timeout=150)
            if not health('http://127.0.0.1:3426/v1/models') or not reader_ready():
                raise RuntimeError('post-update health check failed')
        except Exception:
            shutil.copy2(backup, target)
            os.replace(target, BIN)
            command(['systemctl', 'restart', 'geohot-magpie'], timeout=150)
            raise
        print('Magpie updated; gateway and readers healthy', flush=True)
        version = subprocess.check_output([str(BIN), '--version'], timeout=15, text=True)
        version_file = Path('/var/lib/geohot-magpie/version.txt')
        version_file.write_text(version)
        import pwd
        account = pwd.getpwnam('geohot-magpie')
        os.chown(version_file, account.pw_uid, account.pw_gid)
    finally:
        stage.unlink(missing_ok=True)
        recover()

def main():
    os.umask(0o077)
    # Other service users may stat the known ownership marker to yield; files stay private.
    ROOT.mkdir(mode=0o711, parents=True, exist_ok=True)
    ROOT.chmod(0o711)
    with (ROOT / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if '--recover' in sys.argv:
            if not active('geohot-magpie-update'):
                recover()
        else:
            if OWNER.exists():
                recover()
                return
            update()

if __name__ == '__main__':
    main()
