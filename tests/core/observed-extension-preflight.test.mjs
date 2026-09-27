import test from 'node:test';
import assert from 'node:assert/strict';
import { assertObservedExtensionDeliveryCapacity, assertObservedExtensionEvidenceCurrent } from
  '../../.passeur-core/src/core/repository-runtime.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

test('all three revised recipients need two retained delivery slots before publication', () => {
  assert.doesNotThrow(() => assertObservedExtensionDeliveryCapacity([62, 62, 62], 3));
  assert.throws(() => assertObservedExtensionDeliveryCapacity([62, 63, 62], 3),
    { code: 'PEER_DELIVERY_CAPACITY' });
});

test('reserved extension refuses a changed pair or capture without a work revision change', () => {
  const pair = { pair_id: 'pair', subject_id: 'subject', input: { path: 'source.ts' } };
  const pairs = new Map([['pair', pair]]);
  const artifacts = new Map([[JSON.stringify(['work', 'source.ts']), { id: 'capture-a', owner: 'owner' }]]);
  const pins = [{ id: 'pair', digest: canonicalHash(pair) }];
  const captures = [{ id: 'work', path: 'source.ts', artifact: { id: 'capture-a', owner: 'owner' } }];
  assert.doesNotThrow(() => assertObservedExtensionEvidenceCurrent(pins, captures, pairs, artifacts));
  pairs.set('pair', { ...pair, subject_id: 'replacement' });
  assert.throws(() => assertObservedExtensionEvidenceCurrent(pins, captures, pairs, artifacts),
    { code: 'PEER_DELIVERY_STALE' });
  pairs.set('pair', pair);
  artifacts.set(JSON.stringify(['work', 'source.ts']), { id: 'capture-b', owner: 'owner' });
  assert.throws(() => assertObservedExtensionEvidenceCurrent(pins, captures, pairs, artifacts),
    { code: 'PEER_DELIVERY_STALE' });
});
