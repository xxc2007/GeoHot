import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotReader} from '../packages/backend/src/admin/statistic-snapshot.ts';

test('snapshot returns unavailable (rows []) before any successful read, never a fake zero', async () => {
  let calls = 0;
  const read = async () => { calls++; throw new Error('scan busy'); };
  const reader = snapshotReader(read, undefined, () => 1_000_000, { freshMs: 30_000, canRefresh: () => true });
  const snap = await reader.get();
  assert.equal(snap.status.state, 'unavailable');
  assert.deepEqual(snap.rows, []);
  assert.equal(snap.status.asOf, null);
});

test('snapshot keeps last successful rows; stale after fresh window, still not zero', async () => {
  let t = 0;
  let succeed = false;
  const read = async () => (succeed ? [{ v: 3 }] : []);
  const reader = snapshotReader(read, undefined, () => t, { freshMs: 30_000, canRefresh: () => true });
  succeed = true;
  await reader.refresh();
  t = 60_000; // past fresh window, but last good rows survive
  const stale = await reader.get();
  assert.equal(stale.status.state, 'stale');
  assert.deepEqual(stale.rows, [{ v: 3 }]);
  assert.ok(stale.status.asOf);
});

test('only one in-flight refresh; concurrent get() does not queue duplicate scans', async () => {
  let concurrent = 0; let maxConcurrent = 0;
  const read = () => new Promise<number[]>((resolve) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    setTimeout(() => { concurrent--; resolve([1]); }, 20);
  });
  const reader = snapshotReader(read, undefined, () => 0, { freshMs: 30_000, canRefresh: () => true });
  await Promise.all([reader.get(), reader.get(), reader.get()]);
  assert.equal(maxConcurrent, 1);
});
