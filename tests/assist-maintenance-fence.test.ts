import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * On a stock Windows box `python3` is the Microsoft Store alias: it prints "Python was not found" and exits
 * 9009, which reads as a broken fence when the only thing missing is an interpreter. Resolve a real one
 * first — the override, then the PATH names, then the per-user installs — and skip with the reason if the
 * machine has none. The fence itself is unchanged; nothing is asserted about a stub that never ran.
 */
function resolvePython(): string | null {
  const storeRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python") : null;
  const discovered = storeRoot && existsSync(storeRoot)
    ? readdirSync(storeRoot).filter((d) => /^Python3\d+$/.test(d)).sort().reverse()
        .map((d) => path.join(storeRoot, d, "python.exe")).filter(existsSync)
    : [];
  for (const bin of [process.env.GEOHOT_TEST_PYTHON, "python3", "python", ...discovered]) {
    if (!bin) continue;
    try {
      execFileSync(bin, ["-c", "import sys; assert sys.version_info[0] == 3"], { stdio: ["ignore", "ignore", "ignore"] });
      return bin;
    } catch { /* the Store alias, a broken install and a missing file all land here alike */ }
  }
  return null;
}
const PYTHON = resolvePython();

test("server assist fence excludes concurrent maintenance and retains isolation after disconnect", {
  skip: PYTHON ? false : "no working python3 here: GEOHOT_TEST_PYTHON is unset and `python3` is the Microsoft Store alias",
}, () => {
  const result = execFileSync(PYTHON as string, ["-c", `
import importlib.util,tempfile,pathlib,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('fence','deploy/geohot/assist-maintenance-fence.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
import ast
tree=ast.parse(pathlib.Path('deploy/geohot/magpie-maintenance.py').read_text())
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='owns_maintenance')
scope={};exec(compile(ast.Module(body=[fn],type_ignores=[]),'maintenance','exec'),scope)
owns=scope['owns_maintenance']
assert not owns({'owner':'workstation-extraction','session':'a'*32})
assert not owns({'owner':'release','workerWasActive':True,'at':100})
assert not owns({})
assert owns({'owner':'magpie-update','workerWasActive':True,'at':100})
assert owns({'workerWasActive':False,'at':100}) # Existing maintenance evidence survives upgrade.
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'owner.json'
 m.acquire(p,'a'*32)
 assert m.owned(p,'a'*32)
 assert not m.owned(p,'b'*32)
 try:m.acquire(p,'b'*32)
 except FileExistsError:pass
 else:raise AssertionError('second helper stole maintenance owner')
 try:m.release(p,'b'*32)
 except PermissionError:pass
 else:raise AssertionError('foreign helper removed owner')
 assert p.exists() # A lost SSH connection alone never clears ownership.
 m.release(p,'a'*32)
 p.write_text(json.dumps({'owner':'release'}))
 try:m.acquire(p,'a'*32)
 except FileExistsError:pass
 else:raise AssertionError('helper entered maintenance')
 assert json.loads(p.read_text())['owner']=='release'
 # 2026-11-04: 被杀的会话留下的 workstation owner 不再永久锁死本机辅助。超过 STALE_AFTER 的
 # workstation owner 被改名留证后接管；他人 owner 与新鲜锁照旧 fail closed。
 import os,time
 q=pathlib.Path(d)/'stale.json'
 m.acquire(q,'c'*32)
 os.utime(q,(time.time()-3600,)*2)
 m.acquire(q,'d'*32)
 assert m.owned(q,'d'*32)
 assert any(n.startswith('worker-owner.json.stale-') for n in os.listdir(d)), 'stale owner must be kept as evidence'
 m.release(q,'d'*32)
 f=pathlib.Path(d)/'foreign.json'
 f.write_text(json.dumps({'owner':'release'}))
 os.utime(f,(time.time()-3600,)*2)
 try:m.acquire(f,'e'*32)
 except FileExistsError:pass
 else:raise AssertionError('a foreign owner is never taken over, however old')
print('FENCE_OK')
`], { encoding: "utf8" });
  assert.match(result, /FENCE_OK/);
});
