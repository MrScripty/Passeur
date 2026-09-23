import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { fixture, A, B, C, key, register, repo } from '../fixtures/structural/coordination-fixture.mjs';

const grant = (work, recipients, operation_key = key()) => ({ kind: 'grant_source', operation_key,
  work_id: work.id, expected_revision: work.revision, recipients });

test('source grants migrate to durable v5 and enforce exact recipient scope after reopen', async t => {
  const f = await fixture(t);
  const id = (await f.control.execute(A, register({ readers: [B.owner_id] }))).item_id;
  const before = await f.control.work(A, id);
  await assert.rejects(f.control.sourceWork(B, id, 'report'), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const command = grant(before, [{ recipient: B.owner_id, scope: 'report' }]);
  const receipt = await f.control.execute(A, command);
  assert.deepEqual(await f.control.execute(A, command), receipt);
  assert.equal((await f.disk()).schema_version, 5);
  assert.equal((await f.control.sourceWork(B, id, 'report')).revision, 2);
  await assert.rejects(f.control.sourceWork(B, id, 'detail'), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(f.control.sourceWork(C, id, 'report'), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const reopened = new CoordinationControl(await CoordinationStore.open(f.root, repo, () => {}));
  t.after(() => reopened.close());
  assert.equal((await reopened.sourceWork(B, id, 'report')).source_grants[0].work_revision, 2);
  await reopened.execute(A, grant(await reopened.work(A, id), [{ recipient: B.owner_id, scope: 'detail' }]));
  assert.equal((await reopened.sourceWork(B, id, 'detail')).revision, 3);
});

test('source sharing changes and adoption revoke grants without restoring stale authority', async t => {
  const f = await fixture(t);
  const id = (await f.control.execute(A, register())).item_id;
  await f.control.execute(A, grant(await f.control.work(A, id), [{ recipient: B.owner_id, scope: 'detail' }]));
  await f.control.execute(A, { kind: 'share_work', operation_key: key(), work_id: id, expected_revision: 2, readers: [B.owner_id] });
  await assert.rejects(f.control.sourceWork(B, id, 'report'), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await f.control.execute(A, grant(await f.control.work(A, id), [{ recipient: C.owner_id, scope: 'detail' }]));
  const work = await f.control.work(A, id), state = await f.disk();
  await f.control.recoverAuthorized(C, { kind: 'adopt_work', operation_key: key(), epoch: state.epoch,
    expected_owner: A.owner_id, expected_revision: work.revision, statement: 'Fixture operator transfer',
    work_id: id, new_owner: B.owner_id });
  await assert.rejects(f.control.sourceWork(C, id, 'report'), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  assert.equal((await f.control.sourceWork(B, id, 'detail')).owner, B.owner_id);
  assert.deepEqual((await f.disk()).works[0].source_grants, []);
});

test('grant command refuses stale revision, wrong owner and self grant before durable publication', async t => {
  const f = await fixture(t);
  const id = (await f.control.execute(A, register())).item_id;
  const original = await f.control.work(A, id);
  await assert.rejects(f.control.execute(B, grant(original, [{ recipient: C.owner_id, scope: 'report' }])), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(f.control.execute(A, grant(original, [{ recipient: A.owner_id, scope: 'report' }])), { code: 'COORDINATION_INVALID' });
  await f.control.execute(A, grant(original, [{ recipient: B.owner_id, scope: 'report' }]));
  await assert.rejects(f.control.execute(A, grant(original, [])), { code: 'COORDINATION_STALE_REVISION' });
  assert.equal((await f.disk()).revision, 2);
});
