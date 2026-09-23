import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedPairCache } from '../../.passeur-core/src/observation/cache.js';

test('captured pairs evict by bounded count and never fall back to a path', () => {
  const cache = new CapturedPairCache();
  const absent = { status: 'absent_in_commit', source: { kind: 'commit', repository_id: 'fixture', object_format: 'sha1',
    commit_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), path: 'source.ts' } };
  const pair = { work_id: 'fixture-work', work_revision: 1, input: absent, observed: absent };
  const ids = Array.from({ length: 33 }, () => cache.put(pair));
  assert.throws(() => cache.get(ids[0]), { code: 'STRUCTURAL_DETAIL_UNAVAILABLE' });
  assert.equal(cache.get(ids[32]).work_id, 'fixture-work');
  cache.clear();
  assert.throws(() => cache.get(ids[32]), { code: 'STRUCTURAL_DETAIL_UNAVAILABLE' });
});
