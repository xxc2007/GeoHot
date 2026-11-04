#!/usr/bin/env python3
"""Exclusive maintenance ownership; never infer a drained PC from time or lost SSH.

2026-11-04: ownership used to be permanent until an operator deleted the file by hand. A killed
supervisor (laptop sleep, closed terminal, `systemctl stop`) leaves `worker-owner.json` behind, and
every later acquire answers `acquired: false`, so the workstation helper can be locked out for days.
`worker-owner.json.stale-20261103-workstation-extraction-…` is the fossil of exactly that.

The takeover below is deliberately narrow: only a `workstation-extraction` owner older than
STALE_AFTER seconds is rotated aside (kept, renamed, never deleted), and only then is a fresh
O_EXCL acquire attempted. A live helper refreshes its lease every ~5 s and finishes inside the
20-minute task budget, so a 20-minute-old owner file cannot belong to a running session. Any other
owner name, or a fresh file, still fails closed.
"""
import json
import os
import pathlib
import re
import sys
import time

# 一次本机辅助最多跑 600 秒（supervisor 的 --run-seconds 上限），死在半路的会话留下的
# owner 文件过了 900 秒必然没有活人：再守着它只会让下一轮干等 20 分钟。
# 2026-11-04 现场：失败一轮之后连续三轮都读到 maintenance:true。
STALE_AFTER = int(os.environ.get('GEOHOT_FENCE_STALE_SECONDS', '900'))


def token_ok(token):
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{32}', token):
        raise ValueError('invalid session token')


def owned(path, token):
    token_ok(token)
    try:
        row = json.loads(path.read_text())
        return row.get('owner') == 'workstation-extraction' and row.get('session') == token
    except (OSError, ValueError, AttributeError):
        return False


def stale(path):
    """True only for a workstation owner file that has not been refreshed inside STALE_AFTER."""
    try:
        row = json.loads(path.read_text())
    except (OSError, ValueError, AttributeError):
        return False
    if not isinstance(row, dict) or row.get('owner') != 'workstation-extraction':
        return False
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        return False
    return age >= STALE_AFTER


def rotate(path):
    """Keep the abandoned owner as evidence next to the live name, then let acquire proceed."""
    try:
        row = json.loads(path.read_text())
        session = str(row.get('session'))[:8]
    except (OSError, ValueError, AttributeError):
        session = 'unknown'
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    target = path.with_name('worker-owner.json.stale-%s-workstation-extraction-%s' % (stamp, session))
    os.replace(path, target)
    return target.name


def acquire(path, token):
    """Take ownership, or take over an abandoned workstation owner and report the evidence name."""
    token_ok(token)
    rotated = None
    for attempt in (1, 2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if attempt == 2 or not stale(path):
                raise
            rotated = rotate(path)
            continue
        with os.fdopen(fd, 'w') as stream:
            json.dump({'owner': 'workstation-extraction', 'session': token}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return rotated


def release(path, token):
    if not owned(path, token):
        raise PermissionError('foreign maintenance owner')
    path.unlink()


if __name__ == '__main__':
    request = json.load(sys.stdin)
    owner = pathlib.Path('/var/lib/geohot-maintenance/worker-owner.json')
    if request['action'] == 'acquire':
        if pathlib.Path('/run/geohot-r115-gate').exists() or pathlib.Path('/etc/geohot/r115-gate.disarmed').exists():
            raise RuntimeError('resource maintenance active')
        try:
            rotated = acquire(owner, request['session'])
        except FileExistsError:
            print(json.dumps({'acquired': False}))
            sys.exit(0)
        print(json.dumps({'acquired': True, 'staleRotated': rotated}))
    elif request['action'] == 'release':
        release(owner, request['session'])
    else:
        raise ValueError('invalid action')
    if request['action'] == 'release':
        print(json.dumps({'released': True}))