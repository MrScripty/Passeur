import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { NativeAnalysisHelper } from '../../.passeur-native/src/observation/helper.js';
import { MAX_HELPER_REPLY_BYTES } from '../../.passeur-native/src/observation/helper-protocol.js';

function captured(sequence) {
  const text = 'export function measured(value: number): number { return value + 1; }\n';
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'v04-real-child', object_format: 'sha1',
    workspace_id: 'v04-workspace', workspace_generation: 1, capture_id: `capture-${sequence}`,
    capture_sequence: sequence, head_anchor: 'a'.repeat(40), path: 'source.ts' }, mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  text, consistency: 'sampled_file_not_atomic' };
}

// The exact production helper child runs native extraction. This test-only
// boundary changes its output stream after extraction, before parent decoding.
async function alteredChildReply(mutate, expectedCode) {
  const helper = new NativeAnalysisHelper();
  const originalEmit = ChildProcess.prototype.emit;
  let target;
  ChildProcess.prototype.emit = function(event, ...args) {
    if (event === 'spawn' && !target && this.spawnargs?.some(value => String(value).endsWith('/helper-main.js'))) {
      target = this;
      const stdout = this.stdout;
      const originalStdoutEmit = stdout.emit;
      let buffered = Buffer.alloc(0);
      stdout.emit = function(kind, ...values) {
        if (kind !== 'data') return originalStdoutEmit.call(this, kind, ...values);
        buffered = Buffer.concat([buffered, values[0]]);
        if (!buffered.includes(10)) return true;
        const parsed = JSON.parse(buffered.toString('utf8'));
        const modified = mutate(parsed);
        buffered = Buffer.alloc(0);
        return originalStdoutEmit.call(this, 'data', Buffer.from(modified));
      };
    }
    return originalEmit.call(this, event, ...args);
  };
  try {
    await assert.rejects(helper.extract(captured(1), 'typescript'), { code: expectedCode });
    assert.ok(target?.pid, 'the mutation must intercept a real native child');
    const later = await helper.extract(captured(2), 'typescript');
    assert.equal(later.declarations[0].name, 'measured', 'a failed reply cannot poison the next helper generation');
  } finally {
    ChildProcess.prototype.emit = originalEmit;
    await helper.close();
  }
}

test('supplemental real-child reply mutations reject wrong dialect, parser catalog, generation, digest and job identity', async () => {
  const variants = [
    frame => { frame.extraction.dialect = 'rust'; return frame; },
    frame => { frame.extraction.parser_identity = 'unselected-parser'; return frame; },
    frame => { frame.extraction.source.source.workspace_generation = 2; return frame; },
    frame => { frame.extraction.source.content_sha256 = 'f'.repeat(64); return frame; },
    frame => { frame.job_id = '00000000-0000-0000-0000-000000000000'; return frame; },
  ];
  for (const change of variants) {
    await alteredChildReply(frame => `${JSON.stringify(change(frame))}\n`, 'STRUCTURAL_HELPER_REPLY_INVALID');
  }
});

test('superseding a stopped native child terminates only its generation and starts the queued current job', { skip: process.platform !== 'linux' }, async () => {
  const helper = new NativeAnalysisHelper();
  const originalEmit = ChildProcess.prototype.emit;
  let stoppedPid;
  let stopSpawn;
  const spawned = new Promise(resolve => { stopSpawn = resolve; });
  ChildProcess.prototype.emit = function(event, ...args) {
    if (event === 'spawn' && !stoppedPid && this.spawnargs?.some(value => String(value).endsWith('/helper-main.js'))) {
      stoppedPid = this.pid;
      this.kill('SIGSTOP');
      stopSpawn();
    }
    return originalEmit.call(this, event, ...args);
  };
  try {
    const controller = new AbortController();
    const stale = helper.extract(captured(1), 'typescript', controller.signal);
    const current = helper.extract(captured(2), 'typescript');
    await spawned;
    controller.abort(Object.assign(new Error('source generation superseded'), { code: 'STRUCTURAL_SOURCE_SUPERSEDED' }));
    await assert.rejects(stale, { code: 'STRUCTURAL_SOURCE_SUPERSEDED' });
    const result = await current;
    assert.equal(result.source.source.capture_id, 'capture-2');
    assert.equal(result.declarations[0].name, 'measured');
  } finally {
    ChildProcess.prototype.emit = originalEmit;
    if (stoppedPid) { try { process.kill(stoppedPid, 'SIGKILL'); } catch { /* Already reaped by its owner. */ } }
    await helper.close();
  }
});

test('supplemental real-child reply mutations reject malformed, truncated and oversized framed output', async () => {
  await alteredChildReply(() => '{invalid-json}\n', 'STRUCTURAL_HELPER_REPLY_INVALID');
  await alteredChildReply(frame => JSON.stringify(frame).slice(0, -5), 'STRUCTURAL_HELPER_REPLY_INVALID');
  await alteredChildReply(() => 'x'.repeat(MAX_HELPER_REPLY_BYTES + 1), 'STRUCTURAL_HELPER_REPLY_TOO_LARGE');
});

test('killing the actual native analysis child reports incomplete and drains its slot', async () => {
  const helper = new NativeAnalysisHelper();
  const originalEmit = ChildProcess.prototype.emit;
  let killedPid;
  ChildProcess.prototype.emit = function(event, ...args) {
    if (event === 'spawn' && !killedPid && this.spawnargs?.some(value => String(value).endsWith('/helper-main.js'))) {
      killedPid = this.pid;
      this.kill('SIGKILL');
    }
    return originalEmit.call(this, event, ...args);
  };
  try {
    await assert.rejects(helper.extract(captured(1), 'typescript'), { code: 'STRUCTURAL_ANALYSIS_INCOMPLETE' });
    assert.ok(killedPid);
    const next = await helper.extract(captured(2), 'typescript');
    assert.equal(next.declarations[0].name, 'measured');
  } finally {
    ChildProcess.prototype.emit = originalEmit;
    await helper.close();
  }
});

test('a stopped real analysis child times out, is terminated, and releases the queued generation', { skip: process.platform !== 'linux' }, async () => {
  const helper = new NativeAnalysisHelper();
  const originalEmit = ChildProcess.prototype.emit;
  let stoppedPid;
  ChildProcess.prototype.emit = function(event, ...args) {
    if (event === 'spawn' && !stoppedPid && this.spawnargs?.some(value => String(value).endsWith('/helper-main.js'))) {
      stoppedPid = this.pid;
      this.kill('SIGSTOP');
    }
    return originalEmit.call(this, event, ...args);
  };
  try {
    const stalled = helper.extract(captured(1), 'typescript');
    const waiting = helper.extract(captured(2), 'typescript');
    await assert.rejects(stalled, { code: 'STRUCTURAL_ANALYSIS_TIMEOUT' });
    assert.ok(stoppedPid, 'the test must stop the native child, not a coding worker');
    assert.equal((await waiting).declarations[0].name, 'measured');
  } finally {
    ChildProcess.prototype.emit = originalEmit;
    if (stoppedPid) { try { process.kill(stoppedPid, 'SIGKILL'); } catch { /* Already reaped by its owner. */ } }
    await helper.close();
  }
}, 40_000);
