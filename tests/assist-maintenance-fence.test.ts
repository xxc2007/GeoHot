import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

test("server assist fence excludes concurrent maintenance and retains isolation after disconnect", () => {
  const result = execFileSync(process.env.GEOHOT_TEST_PYTHON || "python3", ["-c", `
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
print('FENCE_OK')
`], { encoding: "utf8" });
  assert.match(result, /FENCE_OK/);
});
