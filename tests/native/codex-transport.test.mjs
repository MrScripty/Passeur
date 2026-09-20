import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const compiled = process.env.PASSEUR_NATIVE_BUILD ?? resolve(root, '.passeur-native');
const { CodexStdio, decodeEnvelope } = await import(pathToFileURL(resolve(compiled, 'src/agents/codex/transport.js')).href);
const fixture = resolve(root, 'tests/fixtures/codex/native-server.mjs');
function peer(mode, options = {}) {
  return new CodexStdio({ command: process.execPath, args: [fixture, mode], cwd: root, env: {},
    request: async () => null, notification: () => undefined, ...options });
}
const budget = () => AbortSignal.timeout(3000);
const code = (expected) => (error) => error?.code === expected;

test('envelopes preserve ID domains and reject ambiguous authority', () => {
  assert.deepEqual(decodeEnvelope({ id: '7', result: { ok: true } }), { id: '7', result: { ok: true } });
  for (const value of [[], { id: 1, result: null, error: {} }, { id: NaN, result: null }, { method: 'x', id: {} }, { id: 1, result: null, jsonrpc: '2.0' }]) {
    assert.throws(() => decodeEnvelope(value), code('CODEX_PROTOCOL_INVALID'));
  }
});
test('real pipe reassembles split UTF-8 and correlates responses', async () => {
  const transport = peer('split');
  try {
    assert.deepEqual(await transport.request('echo', { tree: '🌲', words: 'passeur' }, budget()), { tree: '🌲', words: 'passeur' });
    assert.equal(await transport.close(1500), true);
    assert.equal(transport.operationFailure, undefined);
  } finally { await transport.close(1500); }
});
test('human callback does not block independent native response dispatch', async () => {
  let release;
  const approval = new Promise((resolve) => { release = resolve; });
  const transport = peer('approval', { request: () => approval });
  try {
    assert.equal(await transport.request('start', {}, budget()), 'started');
    assert.equal(await transport.request('ping', 'independent', budget()), 'independent');
    release({ decision: 'decline' });
    assert.equal(await transport.close(1500), true);
  } finally { release(null); await transport.close(1500); }
});
for (const [mode, expected] of [['malformed', 'CODEX_PROTOCOL_INVALID'], ['bad-utf8', 'CODEX_PROTOCOL_INVALID'], ['oversize', 'CODEX_FRAME_TOO_LARGE'], ['unmatched', 'CODEX_PROTOCOL_INVALID']]) {
  test(`real native ${mode} output terminates the request without a substitute result`, async () => {
    const transport = peer(mode);
    try { await assert.rejects(transport.request('go', {}, budget()), code(expected)); }
    finally { assert.equal(await transport.close(1500), true); }
  });
}
test('duplicate outstanding native approval identity is rejected', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const transport = peer('duplicate', { request: () => waiting });
  try { await assert.rejects(transport.request('go', {}, budget()), code('CODEX_PROTOCOL_INVALID')); }
  finally { release(null); assert.equal(await transport.close(1500), true); }
});
test('cancellation detaches a blocked pipe write and close drains the actual child', async () => {
  const transport = peer('no-input');
  const signal = AbortSignal.timeout(40);
  try {
    await assert.rejects(transport.request('large', 'a'.repeat(900_000), signal), (error) => error === signal.reason);
  } finally { assert.equal(await transport.close(1500), true); }
});
test('spawn failure has no started worker and remains observable', async () => {
  const transport = new CodexStdio({ command: '/passeur-test-no-such-command', args: [], cwd: root, env: {}, request: async () => null, notification: () => undefined });
  try { await assert.rejects(transport.request('hello', {}, budget()), code('CODEX_START_FAILED')); }
  finally { assert.equal(transport.started, false); assert.equal(await transport.close(1500), true); }
});
test('a descendant outliving its parent prevents confirmed shutdown', async () => {
  const transport = peer('orphan');
  let descendant;
  try {
    ({ descendant } = await transport.request('go', {}, budget()));
    assert.ok(Number.isSafeInteger(descendant));
    assert.equal(await transport.close(500), false);
    assert.doesNotThrow(() => process.kill(descendant, 0));
  } finally {
    // The fixture's uniquely reported child is owned by this test, not an arbitrary group.
    if (descendant) { try { process.kill(descendant, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await transport.close(500);
  }
});
