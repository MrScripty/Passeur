import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { fixture, A, B, C, key, register, repo } from '../fixtures/structural/coordination-fixture.mjs';

const watch = (work, watchers) => ({ kind: 'watch_source', operation_key: key(), work_id: work.id,
  expected_revision: work.revision, watchers });

test('owner publishes bounded exact watches and explicit dialect overrides durably', async t => {
  const f = await fixture(t), id = (await f.control.execute(A, register())).item_id;
  await f.control.execute(A, watch(await f.control.work(A, id), [
    { recipient: A.owner_id, regions: [{ kind: 'file', path: 'src/view.js' }],
      dialect_overrides: [{ path: 'src/view.js', dialect: 'jsx' }] },
  ]));
  assert.equal((await f.disk()).schema_version, 6);
  const reopened = new CoordinationControl(await CoordinationStore.open(f.root, repo, () => {}));
  t.after(() => reopened.close());
  const work = await reopened.work(A, id);
  assert.deepEqual(work.source_watches, [{ recipient: A.owner_id, regions: [{ kind: 'file', path: 'src/view.js' }],
    dialect_overrides: [{ path: 'src/view.js', dialect: 'jsx' }], work_revision: 2 }]);
  await reopened.execute(A, watch(work, [{ recipient: A.owner_id, regions: [{ kind: 'file', path: 'include/api.h' }],
    dialect_overrides: [{ path: 'include/api.h', dialect: 'cpp' }] }]));
  assert.equal((await reopened.work(A, id)).source_watches[0].dialect_overrides[0].dialect, 'cpp');
});

test('watch recipients require explicit current source grant; grant changes and adoption revoke watches', async t => {
  const f = await fixture(t), id = (await f.control.execute(A, register())).item_id;
  await assert.rejects(f.control.execute(A, watch(await f.control.work(A, id), [
    { recipient: B.owner_id, regions: [{ kind: 'file', path: 'src/a.ts' }] },
  ])), { code: 'COORDINATION_FORBIDDEN' });
  await f.control.execute(A, { kind: 'grant_source', operation_key: key(), work_id: id, expected_revision: 1,
    recipients: [{ recipient: B.owner_id, scope: 'report' }] });
  await f.control.execute(A, watch(await f.control.work(A, id), [
    { recipient: B.owner_id, regions: [{ kind: 'file', path: 'src/a.ts' }] },
  ]));
  assert.equal((await f.control.sourceWork(B, id, 'report')).revision, 3);
  await f.control.execute(A, { kind: 'grant_source', operation_key: key(), work_id: id, expected_revision: 3, recipients: [] });
  assert.deepEqual((await f.control.work(A, id)).source_watches, []);
  await assert.rejects(f.control.sourceWork(B, id, 'report'), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await f.control.execute(A, watch(await f.control.work(A, id), [
    { recipient: A.owner_id, regions: [{ kind: 'subtree', path: 'src' }] },
  ]));
  const current = await f.control.work(A, id), epoch = (await f.disk()).epoch;
  await f.control.recoverAuthorized(C, { kind: 'adopt_work', operation_key: key(), epoch,
    expected_owner: A.owner_id, expected_revision: current.revision,
    statement: 'Fixture operator transfer', work_id: id, new_owner: B.owner_id });
  assert.deepEqual((await f.control.work(B, id)).source_watches, []);
});

test('watch dialect overrides cannot guess syntax for broad or mismatched paths', async t => {
  const f = await fixture(t), id = (await f.control.execute(A, register())).item_id;
  const item = await f.control.work(A, id);
  for (const watchers of [
    [{ recipient: A.owner_id, regions: [{ kind: 'subtree', path: 'src' }],
      dialect_overrides: [{ path: 'src/view.js', dialect: 'jsx' }] }],
    [{ recipient: A.owner_id, regions: [{ kind: 'file', path: 'src/view.js' }],
      dialect_overrides: [{ path: 'src/view.js', dialect: 'cpp' }] }],
    [{ recipient: A.owner_id, regions: [{ kind: 'file', path: 'include/api.h' }],
      dialect_overrides: [{ path: 'include/api.h', dialect: 'jsx' }] }],
    [{ recipient: A.owner_id, regions: [{ kind: 'file', path: 'include/api.h' }],
      dialect_overrides: [{ path: 'include/api.h', dialect: 'c' }] },
    { recipient: B.owner_id, regions: [{ kind: 'file', path: 'include/api.h' }],
      dialect_overrides: [{ path: 'include/api.h', dialect: 'cpp' }] }],
  ]) await assert.rejects(f.control.execute(A, watch(item, watchers)), { code: 'COORDINATION_INVALID' });
  assert.equal((await f.disk()).schema_version, 1);
});
