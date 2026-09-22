import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CoordinationStore } from '../../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../../.passeur-core/src/coordination/control.js';

// These are test principals and metadata descriptors, not authenticated hosts or verified Git workspaces.
export const A = { owner_id: 'a'.repeat(64) }, B = { owner_id: 'b'.repeat(64) }, C = { owner_id: 'c'.repeat(64) };
export const repo = 'coordination-fixture';
export const limits = { works: 64, cases: 64, notes: 256, receipts: 1024, note_bytes: 4096 };
export const key = () => randomUUID();
export const register = (patch = {}) => ({ kind: 'register_work', operation_key: key(), workspace_id: key(), input_oid: '1'.repeat(40), object_format: 'sha1', intent: 'fixture work', areas: [], readers: [], ...patch });
export const claim = (patch = {}) => ({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [], ...patch });
export const caseOp = (kind, item, patch = {}) => ({ kind, operation_key: key(), case_id: item.id, expected_revision: item.revision, generation: item.generation, ...patch });
export const post = (subject, patch = {}) => ({ kind: 'post_note', operation_key: key(), subject, note_kind: 'statement', text: 'attributed note', parties: [], ...patch });
export async function fixture(t, override = {}, authority = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-coordination-'));
  const store = await CoordinationStore.initialize(root, repo, { ...limits, ...override }, authority);
  const control = new CoordinationControl(store);
  t.after(async () => {
    await control.close();
    await rm(root, { recursive: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG, JSON.stringify({ root, disposition: 'removed-test-owned', kind: 'coordination-store' }) + '\n');
  });
  return { root, store, control, file: join(root, 'coordination/control.json'), async disk() { return JSON.parse(await readFile(join(root, 'coordination/control.json'), 'utf8')); } };
}
