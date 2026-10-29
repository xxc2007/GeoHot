#!/usr/bin/env python3
"""Exclusive maintenance ownership; never infer a drained PC from time or lost SSH."""
import json
import os
import pathlib
import re
import sys


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


def acquire(path, token):
    token_ok(token)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'owner': 'workstation-extraction', 'session': token}, stream)
        stream.flush()
        os.fsync(stream.fileno())


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
            acquire(owner, request['session'])
        except FileExistsError:
            print(json.dumps({'acquired': False}))
            sys.exit(0)
    elif request['action'] == 'release':
        release(owner, request['session'])
    else:
        raise ValueError('invalid action')
    print(json.dumps({'acquired': request['action'] == 'acquire', 'released': request['action'] == 'release'}))
