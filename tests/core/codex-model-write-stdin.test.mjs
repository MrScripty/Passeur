import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSchema, presentedCommand } from '../../scripts/qualify-codex-model-exec.mjs';
import { stdinSchema, ttyCommand, ttyProbes, ttyExecArgs, ttyStdinArgs, ttyCall, ttyFinal,
  pairedTtyOutput, parseSession, parseExit, firstSessionDiagnosticGate, retainFirstSessionDiagnostic,
  firstRejectedCallDiagnosticEligible, retainFirstRejectedCallDiagnostic, rejectedArtifactStopEligible, recordTtyNative,
  ttyResult, protectedWriteEffectDiagnostic, ttyFinalStatus, ttyRuntimePaths, prepareTtyRuntimeHome, ttyHostEnvironment,
  ttyGuestEnvironment, ttyShadowDestination, prepareTtyExecutableTargets, ttyNamespaceArguments,
  ttyRuntimeBindingStatus, inspectTtyExecutableBinds, inspectLiveTtyAlias, ttyAliasRetired,
  ttyProtectedHostIntact } from '../../scripts/qualify-codex-model-write-stdin.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const names = ['exec_command', 'write_stdin', 'request_user_input', 'view_image', 'get_goal', 'create_goal', 'update_goal'];
const marker0 = 'a'.repeat(32), marker1 = 'b'.repeat(32);
const probes = ttyProbes('/tmp/work', '/tmp/codex/auth.json', marker0, marker1);
const issued = [
  { callId: 'call_passeur_exec_0', name: 'exec_command', args: ttyExecArgs(probes[0]) },
  { callId: 'call_passeur_stdin_0', name: 'write_stdin', args: ttyStdinArgs(1234, marker0) },
  { callId: 'call_passeur_exec_1', name: 'exec_command', args: ttyExecArgs(probes[1]) },
  { callId: 'call_passeur_stdin_1', name: 'write_stdin', args: ttyStdinArgs(5678, marker1) },
];
const call = entry => ({ type: 'function_call', call_id: entry.callId, name: entry.name, arguments: JSON.stringify(entry.args) });
const output = (entry, text) => ({ type: 'function_call_output', call_id: entry.callId, output: text });
const live = id => 'Chunk ID: a1\nWall time: 0.1 seconds\nProcess running with session ID ' + id + '\nOriginal token count: 0\nOutput:\n';
const exited = code => 'Chunk ID: b2\nWall time: 0.2 seconds\nProcess exited with code ' + code + '\nOriginal token count: 0\nOutput:\n';

test('write_stdin declaration must match exact source-backed four-property schema', () => {
  const execParameters = { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false };
  const stdinParameters = { type: 'object', properties: {
    session_id: { type: 'number', description: 'Session identifier.' },
    chars: { type: 'string', description: 'Bytes to write.' },
    yield_time_ms: { type: 'number', description: 'Wait.' },
    max_output_tokens: { type: 'number', description: 'Budget.' } }, required: ['session_id'], additionalProperties: false };
  const body = { model: 'gpt-5.3-codex', tools: names.map(name => ({ type: 'function', name,
    parameters: name === 'write_stdin' ? stdinParameters : execParameters })) };
  // The committed exec fixture pins its observed digest; structural stdin tests use the same accepted exec shape.
  assert.equal(execSchema(body, sha(JSON.stringify(execParameters))), 'accepted');
  assert.equal(stdinSchema(body), 'exec_schema_mismatch');
  assert.equal(stdinSchema(body, sha(JSON.stringify(execParameters))), 'accepted');
  assert.equal(stdinSchema({ ...body, tools: body.tools.map(tool =>
    tool.name === 'write_stdin' ? { ...tool, parameters: { ...stdinParameters, required: [] } } : tool) },
  sha(JSON.stringify(execParameters))), 'stdin_schema_mismatch');
  assert.equal(stdinSchema({ ...body, tools: body.tools.map(tool =>
    tool.name === 'write_stdin' ? { ...tool, parameters: { ...stdinParameters, anyOf: [] } } : tool) },
  sha(JSON.stringify(execParameters))), 'stdin_schema_mismatch');
  assert.equal(stdinSchema({ ...body, tools: body.tools.map(tool =>
    tool.name === 'write_stdin' ? { ...tool, parameters: { ...stdinParameters,
      properties: { ...stdinParameters.properties, chars: { type: 'string', description: 'Bytes to write.', enum: ['x'] } } } } : tool) },
  sha(JSON.stringify(execParameters))), 'stdin_schema_mismatch');
});

test('two fixed TTY commands bind safe paths, exact shell and newline arguments', () => {
  assert.equal(probes.length, 2);
  assert.equal(probes[0].cmd, 'IFS= read -rs line; printf %s "$line" > /tmp/work/tty-written');
  assert.equal(probes[1].cmd, 'IFS= read -rs line; printf %s "$line" > /tmp/codex/auth.json');
  assert.equal(ttyExecArgs(probes[0]).tty, true);
  assert.equal(ttyExecArgs(probes[0]).shell, '/bin/bash');
  assert.deepEqual(ttyStdinArgs(1234, marker0), { session_id: 1234, chars: marker0 + '\n',
    yield_time_ms: 1000, max_output_tokens: 1000 });
  assert.throws(() => ttyStdinArgs('1234', marker0));
  assert.throws(() => ttyStdinArgs(0, marker0));
  assert.throws(() => ttyStdinArgs(1234, 'secret'));
  assert.throws(() => ttyCommand('/tmp/work;touch /tmp/x'));
});

test('SSE emits exact typed exec and stdin calls with distinct IDs', () => {
  for (let i = 0; i < issued.length; i++) {
    const frames = ttyCall(i, issued[i].name, issued[i].args, issued[i].callId).trim().split('\n\n');
    assert.deepEqual(frames.map(frame => frame.split('\n')[0]), ['event: response.created',
      'event: response.output_item.done', 'event: response.completed']);
    const item = JSON.parse(frames[1].split('\n')[1].slice(6)).item;
    assert.equal(item.call_id, issued[i].callId);
    assert.equal(item.name, issued[i].name);
    assert.deepEqual(JSON.parse(item.arguments), issued[i].args);
  }
  assert.equal(ttyFinal().includes('Fixture complete.'), true);
  const cleanup = ttyCall(4, 'write_stdin', { session_id: 1234, chars: '\u0003',
    yield_time_ms: 1000, max_output_tokens: 1000 }, 'call_passeur_cleanup');
  assert.equal(cleanup.includes('call_passeur_cleanup'), true);
  assert.equal(cleanup.includes('\\u0003'), true);
});

test('paired tool history rejects wrong, duplicate, missing and replayed outputs', () => {
  const first = live(1234);
  const input = [call(issued[0]), output(issued[0], first), call(issued[1]), output(issued[1], exited(0))];
  assert.equal(pairedTtyOutput({ input }, 1, issued, [sha(first)]).status, 'accepted');
  assert.equal(pairedTtyOutput({ input: [...input, output(issued[1], exited(0))] }, 1, issued, [sha(first)]).status, 'duplicate_call_or_output');
  assert.equal(pairedTtyOutput({ input: [call(issued[0]), output(issued[0], live(9999)),
    call(issued[1]), output(issued[1], exited(0))] }, 1, issued, [sha(first)]).status, 'historical_output_mismatch');
  assert.equal(pairedTtyOutput({ input: [call(issued[0]), output(issued[0], first),
    { ...call(issued[1]), arguments: '{}' }, output(issued[1], exited(0))] }, 1, issued, [sha(first)]).status, 'call_arguments_mismatch');
  assert.equal(pairedTtyOutput({ input: [call(issued[1]), output(issued[1], exited(0)), { type: 'custom_tool_call', call_id: 'x' }] },
    1, issued, [sha(first)]).status, 'input_shape_unknown');
  assert.equal(pairedTtyOutput({ input: [call(issued[0]), output(issued[0], [{ type: 'input_text', text: first, extra: 1 }])] },
    0, issued).status, 'output_shape_unknown');
  assert.equal(pairedTtyOutput({ input: [call(issued[0]), output(issued[0], { content: first, success: true, extra: 1 })] },
    0, issued).status, 'output_shape_unknown');
});

test('session parser accepts one bounded numeric live ID and terminal exit only', () => {
  assert.deepEqual(parseSession(live(1234)), { status: 'live', sessionId: 1234 });
  assert.equal(parseSession(live(0)).status, 'session_id_invalid');
  assert.equal(parseSession(live(2147483648)).status, 'session_id_invalid');
  assert.equal(parseSession(live(1234) + 'Process running with session ID 5678\n').status, 'session_output_invalid');
  assert.equal(parseSession(exited(0)).status, 'session_output_invalid');
  assert.deepEqual(parseExit(exited(0)), { status: 'exited', exitCode: 0, output: '' });
  assert.deepEqual(parseExit(exited(1)), { status: 'exited', exitCode: 1, output: '' });
  assert.equal(parseSession(live(1234) + 'Process running with session ID 5678\n').status, 'session_output_invalid');
  assert.equal(parseSession('junk\n' + live(1234)).status, 'session_output_invalid');
  assert.equal(parseExit(live(1234)).status, 'exit_output_invalid');
});

test('original exec item and terminal interaction bind numeric session and call ID', () => {
  const state = { probes, sessions: [1234], threadId: 'thread', turnId: 'turn', items: new Map(), interactions: new Map() };
  const item = { type: 'commandExecution', id: 'call_passeur_exec_0',
    command: presentedCommand(probes[0].cmd), processId: '1234', aggregatedOutput: '', status: 'inProgress', exitCode: null };
  const started = { method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item } };
  const interaction = { method: 'item/commandExecution/terminalInteraction',
    params: { threadId: 'thread', turnId: 'turn', itemId: item.id, processId: '1234', stdin: marker0 + '\n' } };
  const completed = { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
    item: { ...item, status: 'completed', exitCode: 0 } } };
  assert.equal(recordTtyNative(state, started, []), true);
  assert.equal(recordTtyNative(state, interaction, []), true);
  assert.equal(recordTtyNative(state, completed, []), true);
  assert.equal(state.items.get(0).processId, '1234');
  assert.equal(state.interactions.get(0).itemId, item.id);
  const otherState = { probes, sessions: [1234], threadId: 'thread', turnId: 'turn',
    items: new Map(), interactions: new Map() };
  assert.throws(() => recordTtyNative(otherState, { ...started,
    params: { ...started.params, item: { ...item, aggregatedOutput: marker1 } } }, []), /start output/);
  assert.throws(() => recordTtyNative(state, interaction, []), /identity/);
  assert.throws(() => recordTtyNative(state, { ...interaction, params: { ...interaction.params, processId: '5678' } }, []), /identity/);
  state.cleanupIssued = true; state.livePhase = 0; state.liveSession = 1234;
  const cleanup = { ...interaction, params: { ...interaction.params, stdin: '\u0003' } };
  assert.equal(recordTtyNative(state, cleanup, []), true);
  assert.equal(state.cleanupInteraction.stdin, '\u0003');
  assert.throws(() => recordTtyNative(state, cleanup, []), /identity/);
});

test('workspace completion and protected denial require original native item and host effect', () => {
  const positive = { id: 'call_passeur_exec_0', started: true, processId: '1234',
    completed: { processId: '1234', exitCode: 0, status: 'completed', output: '' } };
  const interaction = { itemId: positive.id, processId: '1234', stdin: marker0 + '\n' };
  assert.equal(ttyResult(probes[0], 0, parseExit(exited(0)), positive, interaction, 1234, marker0, true, exited(0)), 'positive_write');
  assert.equal(ttyResult(probes[0], 0, parseExit(exited(0)), { ...positive,
    completed: { ...positive.completed, output: null, outputBytes: 0 } }, interaction,
  1234, marker0, true, exited(0)), 'positive_write');
  assert.equal(ttyResult(probes[0], 0, parseExit(exited(0)), positive, interaction, 1234, 'wrong', true, exited(0)), 'positive_write_failed');
  assert.equal(ttyResult(probes[0], 0, parseExit(exited(0) + 'unexpected'), positive, interaction,
    1234, marker0, true, exited(0) + 'unexpected'), 'positive_write_failed');
  assert.equal(ttyResult(probes[0], 0, parseExit(exited(0)), { ...positive,
    completed: { ...positive.completed, output: 'unexpected' } }, interaction,
  1234, marker0, true, exited(0)), 'positive_write_failed');
  assert.equal(ttyResult(probes[0], 0, parseExit(exited(0)), positive, { ...interaction, processId: '9999' },
    1234, marker0, true, exited(0)), 'native_tty_lifecycle_mismatch');
  const diagnostic = 'bash: line 1: ' + probes[1].path + ': No such file or directory';
  const protectedItem = { id: 'call_passeur_exec_1', started: true, processId: '5678',
    completed: { processId: '5678', exitCode: 1, status: 'failed', output: diagnostic } };
  const protectedInteraction = { itemId: protectedItem.id, processId: '5678', stdin: marker1 + '\n' };
  assert.equal(ttyResult(probes[1], 1, parseExit(exited(1) + diagnostic), protectedItem, protectedInteraction,
    5678, null, true, exited(1) + diagnostic), 'denied');
  assert.equal(ttyResult(probes[1], 1, parseExit(exited(1) + diagnostic), protectedItem, protectedInteraction,
    5678, null, false, exited(1) + diagnostic), 'host_canary_changed');
  assert.equal(ttyResult(probes[1], 1, parseExit(exited(1) + diagnostic), { ...protectedItem,
    completed: { ...protectedItem.completed, output: 'bwrap: sandbox setup: Permission denied' } },
  protectedInteraction, 5678, null, true, exited(1) + diagnostic), 'denial_unattributed');
});

test('protected write effect diagnostic separates exit and native status branches without output', () => {
  const probe = probes[1];
  const sessionId = 5678;
  const diagnostic = 'bash: line 1: ' + probe.path + ': Permission denied';
  const interaction = { itemId: 'call_passeur_exec_1', processId: String(sessionId), stdin: marker1 + '\n' };
  const native = { id: interaction.itemId, started: true, processId: String(sessionId),
    completed: { processId: String(sessionId), exitCode: 0, status: 'completed', output: diagnostic } };
  const zero = parseExit(exited(0) + diagnostic);
  assert.equal(ttyResult(probe, 1, zero, native, interaction, sessionId, null, true,
    exited(0) + diagnostic), 'protected_write_effect_or_uncertain');
  assert.deepEqual(protectedWriteEffectDiagnostic(probe, 1, zero, native, interaction, sessionId, true,
    'protected_write_effect_or_uncertain'), { category: 'protected_write_effect_or_uncertain',
    parsedExitCode: 0, nativeCompletionStatus: 'completed', nativeExitCode: 0,
    hostCanaryIntact: true, nativeDiagnosticMatched: true });
  const nonzeroNative = { ...native, completed: { ...native.completed, exitCode: 1, status: 'completed',
    output: 'unattributed native output with synthetic marker ' + marker1 } };
  const nonzero = parseExit(exited(1) + 'other provider output');
  assert.equal(ttyResult(probe, 1, nonzero, nonzeroNative, interaction, sessionId, null, true,
    exited(1) + 'other provider output'), 'protected_write_effect_or_uncertain');
  const result = protectedWriteEffectDiagnostic(probe, 1, nonzero, nonzeroNative, interaction, sessionId, true,
    'protected_write_effect_or_uncertain');
  assert.deepEqual(result, { category: 'protected_write_effect_or_uncertain', parsedExitCode: 1,
    nativeCompletionStatus: 'completed', nativeExitCode: 1, hostCanaryIntact: true,
    nativeDiagnosticMatched: false });
  assert.equal(JSON.stringify(result).includes(marker1), false);
  assert.equal(protectedWriteEffectDiagnostic(probe, 1, nonzero, nonzeroNative, interaction, sessionId, true,
    'denial_unattributed'), null);
  assert.equal(protectedWriteEffectDiagnostic(probe, 1, nonzero, nonzeroNative, interaction, sessionId, false,
    'protected_write_effect_or_uncertain'), null);
  assert.equal(protectedWriteEffectDiagnostic(probe, 1, nonzero, { ...nonzeroNative, id: 'wrong' },
    interaction, sessionId, true, 'protected_write_effect_or_uncertain'), null);
  assert.equal(protectedWriteEffectDiagnostic(probe, 1, nonzero, nonzeroNative, { ...interaction, stdin: 'wrong' },
    sessionId, true, 'protected_write_effect_or_uncertain'), null);
});

test('failure and uncertain stop cannot become a TTY boundary pass', () => {
  const state = { requestCount: 5, completed: 4, turnComplete: true, sessions: [1234, 5678],
    items: new Map([[0, {}], [1, {}]]), interactions: new Map([[0, {}], [1, {}]]), error: null, failure: null,
    cleanupIssued: false, liveSession: null, livePhase: null };
  assert.equal(ttyFinalStatus(state, true, null, false, 'native_turn_observed'), 'sampled_tty_boundary_passed');
  assert.equal(ttyFinalStatus({ ...state, failure: 'denial_unattributed' }, true, null, false,
    'native_turn_observed'), 'denial_unattributed');
  assert.equal(ttyFinalStatus(state, false, null, false, 'native_turn_observed'), 'transport_stop_unconfirmed');
  assert.equal(ttyFinalStatus({ ...state, sessions: [1234, 1234] }, true, null, false,
    'native_turn_observed'), 'sequence_incomplete');
});

test('first malformed workspace exec output is retained once with bounded mode 0600 evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-write-stdin-'));
  try {
    const text = 'unsupported first workspace exec envelope\n';
    const args = { root, text, probe: probes[0], issued: [issued[0]],
      native: { id: 'call_passeur_exec_0', started: true }, parsed: { status: 'session_output_invalid' },
      requestIndex: 1, previous: 0, protectedIntact: true,
      protectedValues: ['synthetic-protected-secret', marker0, marker1] };
    const retained = await retainFirstSessionDiagnostic(args);
    assert.deepEqual(retained, { path: join(root, 'first-positive-exec-output.txt'),
      sha256: sha(text), bytes: Buffer.byteLength(text), category: 'first_positive_exec_output' });
    assert.equal((await stat(retained.path)).mode & 0o777, 0o600);
    assert.equal(await readFile(retained.path, 'utf8'), text);
    assert.equal(await retainFirstSessionDiagnostic(args), null);
    assert.deepEqual(await readdir(root), ['first-positive-exec-output.txt']);
    assert.equal(await readFile(retained.path, 'utf8'), text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('diagnostic refuses wrong call, leak, oversized output, missing native and changed host canary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-write-stdin-'));
  try {
    const base = { root, text: 'unsupported first workspace exec envelope\n', probe: probes[0],
      issued: [issued[0]], native: { id: 'call_passeur_exec_0', started: true },
      parsed: { status: 'session_output_invalid' }, requestIndex: 1, previous: 0,
      protectedIntact: true, protectedValues: ['synthetic-protected-secret', marker0, marker1] };
    const rejected = [
      { requestIndex: 2 }, { previous: 1 }, { issued: [issued[1]] },
      { probe: probes[1] }, { native: null }, { native: { id: 'other', started: true } },
      { parsed: { status: 'live' } }, { protectedIntact: false },
      { text: 'synthetic-protected-secret' }, { text: marker1 },
      { text: 'x'.repeat(513) }, { text: '\ud800' },
      { native: { id: 'call_passeur_exec_0', started: true,
        completed: { output: marker1, outputBytes: Buffer.byteLength(marker1) } } },
      { native: { id: 'call_passeur_exec_0', started: true,
        completed: { output: null, outputBytes: 16385 } } },
      { native: { id: 'call_passeur_exec_0', started: true,
        completed: { output: 'clean', outputBytes: 99 } } },
      { native: { id: 'call_passeur_exec_0', started: true,
        completed: { output: null, outputBytes: 0, canaryExposed: true } } },
    ];
    for (const mutation of rejected) assert.equal(await retainFirstSessionDiagnostic({ ...base, ...mutation }), null);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture refusal reports only the first finite gate, bounded length and native item flags', () => {
  const root = '/tmp/passeur-codex-model-write-stdin-test';
  const base = { root, text: 'workspace-only malformed envelope', probe: probes[0], issued: [issued[0]],
    native: { id: 'call_passeur_exec_0', started: true,
      completed: { status: 'failed', output: null, outputBytes: 0 } },
    parsed: { status: 'session_output_invalid' }, requestIndex: 1, previous: 0,
    protectedIntact: true, protectedValues: ['protected-secret', marker0, marker1] };
  const wrong = firstSessionDiagnosticGate({ ...base, requestIndex: 2, text: 'protected-secret' });
  assert.deepEqual(wrong, { category: 'request_binding_mismatch', outputBytes: 16,
    nativePresent: true, nativeStarted: true, nativeCompleted: true, nativeStatus: 'failed', nativeOutputBytes: 0 });
  assert.equal(firstSessionDiagnosticGate({ ...base, native: null }).category, 'native_item_mismatch');
  assert.equal(firstSessionDiagnosticGate({ ...base, protectedIntact: false }).category, 'host_canary_not_intact');
  assert.equal(firstSessionDiagnosticGate({ ...base, text: 'protected-secret' }).category, 'protected_value_present');
  const oversized = firstSessionDiagnosticGate({ ...base, text: 'x'.repeat(16_500) });
  assert.equal(oversized.category, 'output_over_limit');
  assert.equal(oversized.outputBytes, 16_385);
  assert.equal(JSON.stringify(wrong).includes('protected-secret'), false);
  assert.equal(JSON.stringify(oversized).includes('x'.repeat(32)), false);
  const failureState = { error: null, failure: 'session_output_invalid', requestCount: 2, completed: 0,
    sessions: [], items: new Map(), interactions: new Map(), turnComplete: false };
  assert.equal(ttyFinalStatus(failureState, true, null, false, 'session_output_invalid'), 'session_output_invalid');
});

test('first positive call rejection artifact is bounded, exclusive and retains failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-write-stdin-'));
  try {
    const text = 'native rejection\n'.padEnd(359, 'x');
    const input = { root, text, probe: probes[0], issued: [issued[0]], native: undefined,
      parsed: { status: 'session_output_invalid' }, requestIndex: 1, previous: 0,
      protectedIntact: true, protectedValues: ['synthetic-protected-secret', marker0, marker1],
      itemsCount: 0, sessions: [], liveSession: null, interactionsCount: 0,
      requestCount: 2, nativeEventFault: false };
    assert.equal(firstRejectedCallDiagnosticEligible(input), true);
    const artifact = await retainFirstRejectedCallDiagnostic(input);
    assert.deepEqual(artifact, { path: join(root, 'first-positive-call-rejection.txt'),
      sha256: sha(text), bytes: 359, category: 'first_positive_call_rejection' });
    assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
    assert.equal(await readFile(artifact.path, 'utf8'), text);
    assert.equal(await retainFirstRejectedCallDiagnostic(input), null);
    assert.deepEqual(await readdir(root), ['first-positive-call-rejection.txt']);
    assert.equal(ttyFinalStatus({ error: 'session_output_invalid', failure: 'session_output_invalid' },
      true, null, false, 'session_output_invalid'), 'session_output_invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejection artifact refuses any live-session clue, native item, leak or changed host gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-write-stdin-'));
  try {
    const base = { root, text: 'native rejected before execution', probe: probes[0], issued: [issued[0]],
      native: undefined, parsed: { status: 'session_output_invalid' }, requestIndex: 1, previous: 0,
      protectedIntact: true, protectedValues: ['synthetic-protected-secret', marker0, marker1],
      itemsCount: 0, sessions: [], liveSession: null, interactionsCount: 0,
      requestCount: 2, nativeEventFault: false };
    const mutations = [
      { text: 'warning\nProcess running with session ID 1234' },
      { text: 'SESSION_ID: 1234' }, { text: 'PID=1234' }, { text: '\u001b[31mrejected' },
      { native: { id: 'call_passeur_exec_0' } }, { itemsCount: 1 },
      { sessions: [1234] }, { liveSession: 1234 }, { interactionsCount: 1 },
      { requestCount: 3 }, { nativeEventFault: true },
      { issued: [issued[1]] }, { requestIndex: 2 }, { previous: 1 },
      { parsed: { status: 'live' } }, { protectedIntact: false },
      { text: 'synthetic-protected-secret' }, { text: marker1 },
      { text: 'x'.repeat(513) }, { text: '\ud800' },
    ];
    for (const mutation of mutations) {
      const input = { ...base, ...mutation };
      assert.equal(firstRejectedCallDiagnosticEligible(input), false);
      assert.equal(await retainFirstRejectedCallDiagnostic(input), null);
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejection artifact requires intact post-stop canaries and confirmed host stop', () => {
  const report = { postStopCanariesIntact: true, transportCloseConfirmed: true, hostExitObserved: true };
  const state = { rejectionCandidate: { text: 'bounded' }, error: 'session_output_invalid',
    failure: 'session_output_invalid' };
  assert.equal(rejectedArtifactStopEligible(report, state, null, false), true);
  for (const changed of [{ postStopCanariesIntact: false }, { transportCloseConfirmed: false },
    { hostExitObserved: false }]) assert.equal(rejectedArtifactStopEligible({ ...report, ...changed }, state, null, false), false);
  assert.equal(rejectedArtifactStopEligible(report, { ...state, rejectionCandidate: null }, null, false), false);
  assert.equal(rejectedArtifactStopEligible(report, state, 'native_failed', false), false);
  assert.equal(rejectedArtifactStopEligible(report, state, null, true), false);
  assert.equal(rejectedArtifactStopEligible(report, { ...state, error: 'native_item_invalid' }, null, false), false);
});

test('guest home overlay binds only exact executable FDs and keeps host auth paths distinct', async () => {
  const paths = await prepareTtyRuntimeHome();
  try {
    const node = '/home/jeremy/.nvm/versions/node/v24.12.0/bin/node';
    const elf = '/home/jeremy/.nvm/versions/node/v24.12.0/bin/codex';
    const attestation = { nodeSha: 'a'.repeat(64), nodeIdentity: '66309:1',
      elfSha: 'b'.repeat(64), elfIdentity: '66309:2' };
    assert.deepEqual(ttyRuntimePaths(paths.root), paths);
    assert.notEqual(paths.hostAuthPath, paths.guestAuthPath);
    assert.equal(paths.guestAuthPath, '/home/jeremy/codex/auth.json');
    assert.equal(ttyProbes(paths.workspace, paths.guestAuthPath, marker0, marker1)[1].path, paths.guestAuthPath);
    assert.equal(ttyHostEnvironment(paths.home, { TMPDIR: '/tmp' }).HOME, paths.home);
    assert.equal(ttyGuestEnvironment({ TMPDIR: '/tmp' }).HOME, '/home/jeremy');
    assert.equal(ttyGuestEnvironment({ TMPDIR: '/tmp' }).CODEX_HOME, '/home/jeremy/codex');
    assert.equal(ttyGuestEnvironment({ TMPDIR: '/tmp' }).TMPDIR, '/tmp');
    await prepareTtyExecutableTargets(paths, node, elf);
    assert.equal((await stat(ttyShadowDestination(paths, node))).size, 0);
    assert.equal((await stat(ttyShadowDestination(paths, elf))).size, 0);
    const args = ttyNamespaceArguments(node, '/tmp/fixture.mjs', elf, 'net:[123]', paths.root, attestation);
    assert.deepEqual(args.slice(0, 10), ['--unshare-user', '--unshare-net', '--die-with-parent',
      '--ro-bind', '/', '/', '--bind', '/tmp', '/tmp', '--proc']);
    assert.deepEqual(args.slice(args.indexOf('--bind', 9), args.indexOf('--bind', 9) + 3),
      ['--bind', paths.home, '/home/jeremy']);
    assert.deepEqual(args.slice(args.indexOf('--ro-bind-fd'), args.indexOf('--ro-bind-fd') + 6),
      ['--ro-bind-fd', '3', node, '--ro-bind-fd', '4', elf]);
    assert.equal(args.includes('/passeur-codex-home'), false);
    assert.equal(args.includes('--dir'), false);
    assert.ok(args.includes('--node-identity=66309:1'));
    assert.throws(() => ttyNamespaceArguments('/tmp/node', '/tmp/fixture.mjs', elf, 'net:[123]', paths.root, attestation));
    assert.throws(() => ttyNamespaceArguments(node, '/tmp/fixture.mjs', elf, 'net:[123]', paths.root,
      { ...attestation, nodeSha: 'bad' }));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('missing, mismatched or real-home-visible guest binds fail before a native call', () => {
  const paths = ttyRuntimePaths('/tmp/passeur-codex-model-write-stdin-test');
  const directory = (dev, ino) => ({ dev, ino, isDirectory: () => true, isSymbolicLink: () => false });
  const base = { paths, env: { HOME: '/home/jeremy', CODEX_HOME: '/home/jeremy/codex' },
    layoutPrivate: true, hostHome: directory(1, 2), guestHome: directory(1, 2),
    hostCodex: directory(1, 3), guestCodex: directory(1, 3),
    guestHomeLink: directory(1, 2), guestCodexLink: directory(1, 3),
    sentinelAbsent: true, mountInfo: '1 2 3 / /home/jeremy rw - ext4 /dev/x rw\n' };
  assert.equal(ttyRuntimeBindingStatus(base), 'accepted');
  assert.equal(ttyRuntimeBindingStatus({ ...base, guestHome: directory(1, 99) }), 'bind_identity_mismatch');
  assert.equal(ttyRuntimeBindingStatus({ ...base, guestCodex: directory(1, 99) }), 'bind_identity_mismatch');
  assert.equal(ttyRuntimeBindingStatus({ ...base, mountInfo: '' }), 'bind_mount_missing');
  assert.equal(ttyRuntimeBindingStatus({ ...base, sentinelAbsent: false }), 'real_home_visible');
  assert.equal(ttyRuntimeBindingStatus({ ...base, env: { HOME: paths.home, CODEX_HOME: paths.hostCodexHome } }),
    'environment_mismatch');
  assert.equal(ttyRuntimeBindingStatus({ ...base, layoutPrivate: false }), 'host_layout_invalid');
});

test('executable bind and helper alias reject mismatch and prove retired owned session directory', async () => {
  const paths = await prepareTtyRuntimeHome();
  try {
    const node = process.execPath;
    const fakeElf = '/home/jeremy/.nvm/versions/node/v24.12.0/bin/codex';
    const badAttestation = { nodeSha: 'a'.repeat(64), nodeIdentity: '1:2',
      elfSha: 'b'.repeat(64), elfIdentity: '3:4' };
    assert.notEqual((await inspectTtyExecutableBinds(paths, node, fakeElf, badAttestation)).status, 'accepted');
    const aliasRoot = join(paths.hostCodexHome, 'tmp', 'arg0');
    const aliasDirectory = join(aliasRoot, 'codex-arg0test');
    assert.equal((await inspectLiveTtyAlias(paths.hostCodexHome, node)).status, 'helper_alias_unavailable');
    await mkdir(aliasDirectory, { recursive: true });
    await symlink(node, join(aliasDirectory, 'codex-linux-sandbox'));
    assert.deepEqual(await inspectLiveTtyAlias(paths.hostCodexHome, node), { status: 'accepted', aliasDirectory });
    assert.equal(await ttyAliasRetired(aliasDirectory), false);
    assert.equal((await inspectLiveTtyAlias(paths.hostCodexHome, '/bin/false')).status,
      'helper_alias_target_mismatch');
    await rm(aliasDirectory, { recursive: true });
    assert.equal(await ttyAliasRetired(aliasDirectory), true);
    await writeFile(paths.hostAuthPath, 'fixture-secret', { mode: 0o600 });
    const wrongLink = join(paths.workspace, 'auth-link');
    await symlink(paths.hostAuthPath, wrongLink);
    assert.equal(await ttyProtectedHostIntact(paths, wrongLink, 'fixture-secret'), false);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
