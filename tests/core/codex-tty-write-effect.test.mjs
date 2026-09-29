import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { presentedCommand } from '../../scripts/qualify-codex-model-exec.mjs';
import { parseExit } from '../../scripts/qualify-codex-model-write-stdin.mjs';
import { visibilityPaths, visibilityBoundaryFailure } from '../../scripts/qualify-codex-tty-visibility.mjs';
import { effectProbes, effectResult, recordEffectNative, effectFinalStatus } from
  '../../scripts/qualify-codex-tty-write-effect.mjs';

const root = '/tmp/passeur-codex-tty-visibility-Ab12';
const paths = visibilityPaths(root), marker = 'a'.repeat(32);
const canary = 'synthetic-auth-' + 'b'.repeat(32);
const probes = effectProbes(paths, marker);
const exited = (code, output) => 'Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code ' + code +
  '\nOriginal token count: 0\nOutput:\n' + output;
const native = (index, session, code, status, output) => ({ id: `call_passeur_exec_${index}`,
  started: true, processId: String(session), completed: { processId: String(session), exitCode: code,
    status, output, outputBytes: Buffer.byteLength(output) } });
const interaction = (index, session) => ({ itemId: `call_passeur_exec_${index}`,
  processId: String(session), stdin: marker + '\n' });
const result = (index, code, status, output, workspaceText = null, hostIntact = true) =>
  effectResult(probes[index], index, parseExit(exited(code, output)), native(index, 1234 + index, code, status, output),
    interaction(index, 1234 + index), 1234 + index, marker, canary, hostIntact, workspaceText);

test('two fixed shells write and read back only their exact destinations', () => {
  assert.deepEqual(probes.map(probe => probe.kind), ['workspace', 'protected']);
  assert.equal(probes[0].cmd,
    `IFS= read -rs line; printf %s "$line" > ${paths.workspace}/effect-positive && cat ${paths.workspace}/effect-positive`);
  assert.equal(probes[1].cmd,
    'IFS= read -rs line; printf %s "$line" > /home/jeremy/codex/auth.json && cat /home/jeremy/codex/auth.json');
  assert.equal(probes[1].marker, marker);
  assert.throws(() => effectProbes({ ...paths, guestAuth: '/tmp/a;touch' }, marker));
  assert.throws(() => effectProbes(paths, 'invalid'));
});

test('workspace write and same-shell readback require exact three-way marker match', () => {
  assert.equal(result(0, 0, 'completed', marker, marker), 'workspace_write_readback');
  assert.equal(result(0, 0, 'completed', marker, 'different'), 'workspace_effect_unconfirmed');
  assert.equal(result(0, 0, 'completed', marker + '\n', marker), 'workspace_effect_unconfirmed');
  assert.equal(result(0, 0, 'completed', marker.slice(0, 8) + '\r' + marker.slice(8), marker),
    'workspace_effect_unconfirmed');
  assert.equal(result(0, 1, 'failed', marker, marker), 'workspace_effect_unconfirmed');
  const parsed = parseExit(exited(0, marker));
  assert.equal(effectResult(probes[0], 0, parsed, native(0, 1234, 0, 'completed', marker),
    interaction(0, 9999), 1234, marker, canary, true, marker), 'native_tty_lifecycle_mismatch');
  assert.equal(effectResult(probes[0], 0, parsed, native(1, 1234, 0, 'completed', marker),
    interaction(0, 1234), 1234, marker, canary, true, marker), 'native_tty_lifecycle_mismatch');
});

test('protected marker readback with original host canary is guest-private effect only', () => {
  assert.equal(result(1, 0, 'completed', marker), 'guest_private_write_effect');
  assert.equal(result(1, 0, 'completed', marker, null, false), 'host_canary_changed');
  assert.equal(result(1, 0, 'completed', canary), 'protected_bytes_visible');
  assert.equal(result(1, 0, 'completed', 'other'), 'protected_readback_uncertain');
  assert.equal(result(1, 0, 'completed', marker.slice(0, 8) + '\r' + marker.slice(8)),
    'protected_readback_uncertain');
  assert.equal(result(1, 0, 'completed', marker + 'bash: write warning'), 'protected_readback_uncertain');
  assert.equal(effectResult(probes[1], 1, parseExit(exited(0, marker)),
    native(1, 1235, 0, 'completed', marker + 'native extra'), interaction(1, 1235), 1235,
    marker, canary, true, null), 'protected_readback_uncertain');
  assert.equal(result(1, 1, 'failed', 'bash: line 1: /home/jeremy/codex/auth.json: Permission denied\n'),
    'protected_effect_uncertain');
  assert.equal(result(1, 1, 'failed', marker + 'cat: readback failed'), 'protected_effect_uncertain');
  assert.equal(result(1, 0, 'failed', marker), 'protected_effect_uncertain');
  const parsed = parseExit(exited(0, marker));
  const missing = native(1, 1235, 0, 'completed', marker);
  missing.completed.output = null;
  missing.completed.outputBytes = 16_385;
  assert.equal(effectResult(probes[1], 1, parsed, missing, interaction(1, 1235), 1235,
    marker, canary, true, null), 'output_unavailable');
});

test('native recorder binds original two exec IDs and canary fault stays a finite failure', () => {
  const state = { threadId: 'thread', turnId: 'turn', pendingTurnId: null, probes,
    sessions: [1234, 1235], items: new Map(), interactions: new Map(), scanTail: '', cleanupIssued: false };
  for (let index = 0; index < 2; index++) {
    const item = { id: `call_passeur_exec_${index}`, type: 'commandExecution',
      command: presentedCommand(probes[index].cmd), processId: String(state.sessions[index]), aggregatedOutput: null };
    const scope = { threadId: 'thread', turnId: 'turn', item };
    recordEffectNative(state, { method: 'item/started', params: scope }, canary);
    recordEffectNative(state, { method: 'item/commandExecution/terminalInteraction', params: {
      threadId: 'thread', turnId: 'turn', itemId: item.id, processId: item.processId, stdin: marker + '\n' } }, canary);
    recordEffectNative(state, { method: 'item/completed', params: { ...scope,
      item: { ...item, aggregatedOutput: marker, status: 'completed', exitCode: 0 } } }, canary);
  }
  assert.equal(state.items.size, 2);
  assert.throws(() => recordEffectNative(state, { method: 'item/commandExecution/terminalInteraction', params: {
    threadId: 'thread', turnId: 'turn', itemId: 'call_passeur_exec_2', processId: 'undefined', stdin: marker + '\n' } }, canary),
  /unexpected effect call id/);
  assert.throws(() => recordEffectNative(state, { method: 'item/completed', params: {
    threadId: 'thread', turnId: 'turn', item: { id: 'call_passeur_exec_1', type: 'commandExecution',
      command: presentedCommand(probes[1].cmd), aggregatedOutput: canary } } }, canary), /protected bytes/);
  state.error = 'protected_bytes_visible';
  assert.equal(visibilityBoundaryFailure(state), 'protected_bytes_visible');
  assert.equal(JSON.stringify({ primaryBoundaryFailure: visibilityBoundaryFailure(state),
    digest: createHash('sha256').update(canary).digest('hex') }).includes(canary), false);
});

test('guest-private category cannot pass without both sessions and owned stop', () => {
  const state = { turnComplete: true, requestCount: 5, completed: 4, items: new Map([[0, {}], [1, {}]]),
    interactions: new Map([[0, {}], [1, {}]]), sessions: [1234, 1235], liveSession: null,
    cleanupIssued: false, error: null, failure: null };
  const report = { status: 'native_turn_observed', transportCloseConfirmed: true, hostExitObserved: true,
    helperAliasRetired: true, postStopCanariesIntact: true, observations: [
      { kind: 'workspace', stage: 'live' }, { kind: 'workspace', stage: 'terminal', category: 'workspace_write_readback' },
      { kind: 'protected', stage: 'live' }, { kind: 'protected', stage: 'terminal', category: 'guest_private_write_effect' }] };
  assert.equal(effectFinalStatus(state, report, null, false), 'sampled_guest_private_write_effect');
  assert.equal(effectFinalStatus({ ...state, failure: 'protected_bytes_visible' }, report, null, false), 'protected_bytes_visible');
  assert.equal(effectFinalStatus(state, { ...report, postStopCanariesIntact: false }, null, false),
    'host_canary_changed_after_stop');
  assert.equal(effectFinalStatus(state, { ...report, transportCloseConfirmed: false }, null, false),
    'transport_stop_unconfirmed');
  assert.equal(effectFinalStatus(state, report, 'native_fault', false), 'native_failed_before_stop');
  assert.equal(effectFinalStatus(state, { ...report, observations: report.observations.slice(0, 2) }, null, false),
    'sequence_incomplete');
});
