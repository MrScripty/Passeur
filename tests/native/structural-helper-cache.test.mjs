import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { NativeAnalysisHelper } from '../../.passeur-native/src/observation/helper.js';

function captured(text, sequence) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'cache-test', object_format: 'sha1',
    workspace_id: `workspace-${sequence % 2}`, workspace_generation: sequence, capture_id: `capture-${sequence}`,
    capture_sequence: sequence, head_anchor: 'a'.repeat(40), path: 'source.ts' }, mode: '100644',
    content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
    text, consistency: 'sampled_file_not_atomic' };
}

async function countNativeChildren(run) {
  const originalEmit = ChildProcess.prototype.emit;
  let count = 0;
  ChildProcess.prototype.emit = function(event, ...args) {
    if (event === 'spawn' && this.spawnargs?.some(value => String(value).endsWith('/helper-main.js'))) count++;
    return originalEmit.call(this, event, ...args);
  };
  try { await run(() => count); } finally { ChildProcess.prototype.emit = originalEmit; }
}

test('identical native bytes reuse one validated extraction and retain each capture identity', async () => {
  const helper = new NativeAnalysisHelper();
  const text = 'export function repeat(value: number): number { return value + 1; }\n';
  try {
    await countNativeChildren(async count => {
      const first = captured(text, 1);
      const second = captured(text, 2);
      const [left, right] = await Promise.all([helper.extract(first, 'typescript'), helper.extract(second, 'typescript')]);
      assert.equal(count(), 1, 'queued identical content uses the completed native job');
      assert.equal(left.source.source.capture_id, 'capture-1');
      assert.equal(right.source.source.capture_id, 'capture-2');
      assert.equal(right.declarations[0].name, 'repeat');
      const third = await helper.extract(captured(text, 3), 'typescript');
      assert.equal(count(), 1, 'later identical content also uses the retained extraction');
      assert.equal(third.source.source.capture_id, 'capture-3');
      assert.deepEqual(third.declarations, left.declarations);
      await helper.extract(captured(text, 4), 'tsx');
      assert.equal(count(), 2, 'a different grammar dialect cannot reuse the TypeScript result');
    });
  } finally { await helper.close(); }
});

test('digest disagreement and aborted requests cannot receive a cached extraction', async () => {
  const helper = new NativeAnalysisHelper();
  const text = 'export function trusted() { return 1; }\n';
  try {
    await helper.extract(captured(text, 1), 'typescript');
    const forged = { ...captured('export function different() { return 1; }\n', 2),
      content_sha256: captured(text, 2).content_sha256 };
    await assert.rejects(helper.extract(forged, 'typescript'), { code: 'STRUCTURAL_HELPER_REQUEST_INVALID' });
    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    await assert.rejects(helper.extract(captured(text, 3), 'typescript', controller.signal), /superseded/);
  } finally { await helper.close(); }
});

test('the extraction cache evicts old content after sixteen entries', async () => {
  const helper = new NativeAnalysisHelper();
  try {
    await countNativeChildren(async count => {
      for (let index = 0; index < 17; index++) {
        const result = await helper.extract(captured(`export function name${index}() { return ${index}; }\n`, index), 'typescript');
        assert.equal(result.declarations[0].name, `name${index}`);
      }
      assert.equal(count(), 17);
      await helper.extract(captured('export function name0() { return 0; }\n', 18), 'typescript');
      assert.equal(count(), 18, 'the oldest extraction must have been evicted');
    });
  } finally { await helper.close(); }
});
