import assert from 'node:assert/strict';
import test from 'node:test';
import { captureProtectedNamespace, verifyProtectedNamespaceStop } from '../../dist/src/core/protected-namespace.js';

function observer(childNetwork = 'net:[1]', nativeNetwork = childNetwork) {
  const state = { stopped: false, closes: 0, status: [
    { kind: 'wrapper', pid: 41 }, { 'child-pid': 42 },
  ] };
  const processes = new Map([
    [41, { pid: 41, parent: 0, start: '41', pidns: 'pid:[1]', netns: 'net:[1]', nspid: [41], exe: '/usr/bin/bwrap' }],
    [42, { pid: 42, parent: 41, start: '42', pidns: 'pid:[2]', netns: childNetwork, nspid: [42, 1], exe: '/sbin/init' }],
    [43, { pid: 43, parent: 42, start: '43', pidns: 'pid:[2]', netns: nativeNetwork, nspid: [43, 2], exe: '/bin/codex' }],
  ]);
  const io = {
    status: async () => state.status.map(frame => JSON.stringify(frame)).join('\n') + '\n',
    boot: async () => 'boot',
    identity: async pid => {
      if (state.stopped) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return processes.get(pid);
    },
    members: async () => state.stopped ? [] : [processes.get(42), processes.get(43)],
    openNamespace: async () => ({ fd: 7, close: async () => { state.closes++; } }),
    heldNamespace: async () => 'pid:[2]',
    executable: async () => ({ dev: 1, ino: 2 }),
  };
  return { state, io };
}

const capture = (io, relation) => captureProtectedNamespace('status', '/bin/codex', '/bin/codex', io, relation);
const invalid = error => error?.code === 'PROTECTED_NAMESPACE_INVALID';

test('default capture rejects inherited native networking and closes the PID namespace handle', async () => {
  const { state, io } = observer();
  await assert.rejects(capture(io), invalid);
  assert.equal(state.closes, 1);
});

test('explicit inherited relation accepts native networking with a private PID namespace', async () => {
  const { state, io } = observer();
  const captured = await capture(io, 'inherited');
  assert.equal(captured.nativePid, 43);
  assert.equal(captured.pidns, 'pid:[2]');
  assert.equal(state.closes, 0);
  state.stopped = true;
  state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await verifyProtectedNamespaceStop(captured, 'status', io), true);
  assert.equal(state.closes, 1);
});

test('explicit inherited relation rejects isolated networking', async () => {
  const { state, io } = observer('net:[2]');
  await assert.rejects(capture(io, 'inherited'), invalid);
  assert.equal(state.closes, 1);
});

test('an unknown relation cannot enable inherited networking', async () => {
  const { state, io } = observer();
  await assert.rejects(capture(io, 'unexpected'), invalid);
  assert.equal(state.closes, 1);
});

test('inherited relation still rejects a native process in an inconsistent network namespace', async () => {
  const { state, io } = observer('net:[1]', 'net:[3]');
  await assert.rejects(capture(io, 'inherited'), invalid);
  assert.equal(state.closes, 1);
});

test('inherited networking does not weaken stop verification', async () => {
  const { state, io } = observer();
  const captured = await capture(io, 'inherited');
  state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await verifyProtectedNamespaceStop(captured, 'status', io), false);
  assert.equal(state.closes, 1);
});
