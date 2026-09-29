import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { presentedCommand } from '../../scripts/qualify-codex-model-exec.mjs';
import { parseExit } from '../../scripts/qualify-codex-model-write-stdin.mjs';
import { visibilityPaths, visibilityProbes, visibilityResult, recordVisibilityNative,
  visibilityHostIntact, visibilityNamespaceArguments, visibilityFinalStatus, visibilityBoundaryFailure,
  aliasRetired } from '../../scripts/qualify-codex-tty-visibility.mjs';

const marker = 'a'.repeat(32), secret = 'synthetic-auth-secret-' + 'b'.repeat(24);
const root = '/tmp/passeur-codex-tty-visibility-Ab12';
const paths = visibilityPaths(root), probes = visibilityProbes(paths, marker);
const exited = (code, output) => 'Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code ' + code +
  '\nOriginal token count: 0\nOutput:\n' + output;
const native = (index, session, code, status, output) => ({ id: `call_passeur_exec_${index}`,
  started: true, processId: String(session), completed: { processId: String(session), exitCode: code,
    status, output, outputBytes: Buffer.byteLength(output) } });
const interaction = (index, session) => ({ itemId: `call_passeur_exec_${index}`,
  processId: String(session), stdin: marker + '\n' });
const result = (index, session, code, status, output, positive = 'workspace\n') =>
  visibilityResult(probes[index], index, parseExit(exited(code, output)),
    native(index, session, code, status, output), interaction(index, session), session,
    positive, secret, true);

test('fixed four TTY reads bind direct, symlink and proc aliases to the same disposable home', () => {
  assert.deepEqual(probes.map(probe => probe.kind), ['workspace', 'direct', 'symlink', 'proc']);
  assert.equal(probes[1].path, '/home/jeremy/codex/auth.json');
  assert.equal(probes[2].path, join(root, 'work', 'auth-link'));
  assert.equal(probes[3].path, '/proc/self/root/home/jeremy/codex/auth.json');
  assert.equal(probes[0].cmd, `IFS= read -rs line; cat ${paths.positive}`);
  for (const probe of probes) assert.equal(probe.cmd, `IFS= read -rs line; cat ${probe.path}`);
  assert.throws(() => visibilityProbes({ ...paths, link: '/tmp/unsafe;touch' }, marker));
});

test('workspace control needs exact tool and native bytes under original exec session', () => {
  assert.equal(result(0, 1234, 0, 'completed', 'workspace\n'), 'workspace_read');
  assert.equal(result(0, 1234, 0, 'completed', 'wrong\n'), 'workspace_read_unconfirmed');
  assert.equal(result(0, 1234, 1, 'failed', 'workspace\n'), 'workspace_read_unconfirmed');
  const parsed = parseExit(exited(0, 'workspace\n'));
  assert.equal(visibilityResult(probes[0], 0, parsed, native(0, 1234, 0, 'completed', 'workspace\n'),
    interaction(0, 9999), 1234, 'workspace\n', secret, true), 'native_tty_lifecycle_mismatch');
  assert.equal(visibilityResult(probes[0], 0, parsed, native(1, 1234, 0, 'completed', 'workspace\n'),
    interaction(0, 1234), 1234, 'workspace\n', secret, true), 'native_tty_lifecycle_mismatch');
});

test('protected reads stop on exact canary, successful read or unknown output', () => {
  for (const index of [1, 2, 3]) {
    const path = probes[index].path;
    assert.equal(result(index, 2000 + index, 1, 'failed', `cat: ${path}: Permission denied\n`), 'denied');
    assert.equal(result(index, 2000 + index, 1, 'failed', `cat: ${path}: No such file or directory\n`), 'denied');
    assert.equal(result(index, 2000 + index, 0, 'completed', secret + '\n'), 'protected_bytes_visible');
    assert.equal(result(index, 2000 + index, 0, 'completed', 'unrelated\n'), 'protected_read_visible_or_uncertain');
    assert.equal(result(index, 2000 + index, 1, 'failed', 'bwrap: Permission denied\n'), 'denial_unattributed');
    assert.equal(result(index, 2000 + index, 1, 'failed', `cat: ${probes[1].path}: Permission denied\n`),
      index === 1 ? 'denied' : 'denial_unattributed');
  }
  const parsed = parseExit(exited(1, `cat: ${probes[1].path}: Permission denied\n`));
  const oversized = native(1, 2001, 1, 'failed', 'x'.repeat(16_385));
  oversized.completed.output = null;
  assert.equal(visibilityResult(probes[1], 1, parsed, oversized, interaction(1, 2001), 2001,
    'workspace\n', secret, true), 'output_unavailable');
  assert.equal(visibilityResult(probes[1], 1, parsed, native(1, 2001, 1, 'failed', parsed.output),
    interaction(1, 2001), 2001, 'workspace\n', secret, false), 'host_canary_changed');
});

test('native item and interaction recorder bind all four exact IDs and reject replay', () => {
  const state = { threadId: 'thread', turnId: 'turn', pendingTurnId: null, probes,
    sessions: [1234, 2345, 3456, 4567], items: new Map(), interactions: new Map(),
    scanTail: '', cleanupIssued: false, livePhase: null };
  for (let index = 0; index < 4; index++) {
    const item = { id: `call_passeur_exec_${index}`, type: 'commandExecution',
      command: presentedCommand(probes[index].cmd), processId: String(state.sessions[index]),
      aggregatedOutput: null };
    const scope = { threadId: 'thread', turnId: 'turn', item };
    recordVisibilityNative(state, { method: 'item/started', params: scope }, secret);
    recordVisibilityNative(state, { method: 'item/commandExecution/terminalInteraction', params: {
      threadId: 'thread', turnId: 'turn', itemId: item.id, processId: item.processId,
      stdin: marker + '\n' } }, secret);
    recordVisibilityNative(state, { method: 'item/completed', params: { ...scope,
      item: { ...item, status: 'failed', exitCode: 1, aggregatedOutput: '' } } }, secret);
    assert.equal(state.items.get(index).completed.exitCode, 1);
    assert.throws(() => recordVisibilityNative(state, { method: 'item/completed', params: scope }, secret), /completion/);
  }
  assert.equal(state.items.size, 4);
  assert.throws(() => recordVisibilityNative(state, { method: 'item/started', params: {
    threadId: 'thread', turnId: 'turn', item: { id: 'call_passeur_exec_4', type: 'commandExecution',
      command: presentedCommand(probes[0].cmd) } } }, secret), /identity/);
  assert.throws(() => recordVisibilityNative(state, { method: 'item/commandExecution/terminalInteraction', params: {
    threadId: 'thread', turnId: 'turn', itemId: 'call_passeur_exec_1', processId: 'wrong', stdin: marker + '\n' } }, secret), /session/);
});

test('split native text and decoded protected bytes cause a failed observation before projection', () => {
  const state = { scanTail: '', probes, items: new Map(), interactions: new Map() };
  recordVisibilityNative(state, { method: 'misc', params: { delta: secret.slice(0, 12) } }, secret);
  assert.throws(() => recordVisibilityNative(state,
    { method: 'misc', params: { delta: secret.slice(12) } }, secret), /protected bytes/);
  const text = JSON.stringify({ status: 'protected_bytes_visible', outputSha256: createHash('sha256').update(secret).digest('hex') });
  assert.equal(text.includes(secret), false);
  state.error = 'protected_bytes_visible';
  const stop = { status: 'native_turn_observed', transportCloseConfirmed: true,
    hostExitObserved: true, helperAliasRetired: true, postStopCanariesIntact: true };
  assert.equal(visibilityBoundaryFailure(state), 'protected_bytes_visible');
  assert.equal(visibilityFinalStatus(state, stop, 'CODEX_CALLBACK_OVERLOAD', false), 'native_failed_before_stop');
  assert.equal(JSON.stringify({ primaryBoundaryFailure: visibilityBoundaryFailure(state),
    status: visibilityFinalStatus(state, stop, 'CODEX_CALLBACK_OVERLOAD', false) }).includes(secret), false);
});

test('guest FD home launch binds exactly two attested executable descriptors', () => {
  const attestation = { nodeSha: 'a'.repeat(64), nodeIdentity: '1:2', elfSha: 'b'.repeat(64), elfIdentity: '3:4' };
  const node = '/home/jeremy/.nvm/node', elf = '/home/jeremy/.codex/codex';
  const args = visibilityNamespaceArguments(node, '/tmp/script.mjs', elf, 'net:[123]', paths, attestation);
  assert.deepEqual(args.slice(args.indexOf('--bind', args.indexOf('--bind') + 1),
    args.indexOf('--bind', args.indexOf('--bind') + 1) + 3), ['--bind', paths.home, '/home/jeremy']);
  assert.ok(args.includes('--ro-bind-fd'));
  assert.equal(args.filter(value => value === '--ro-bind-fd').length, 2);
  assert.ok(args.includes('--node-sha=' + attestation.nodeSha));
  assert.throws(() => visibilityNamespaceArguments('/usr/bin/node', '/tmp/script.mjs', elf,
    'net:[123]', paths, attestation));
  assert.throws(() => visibilityNamespaceArguments(node, '/tmp/script.mjs', elf,
    'net:[123]', paths, { ...attestation, elfSha: 'bad' }));
});

test('host canary check refuses guest alias confusion or changed bytes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'passeur-codex-tty-visibility-'));
  const fixture = visibilityPaths(temporary);
  try {
    await mkdir(fixture.hostCodexHome, { recursive: true });
    await mkdir(fixture.workspace);
    await writeFile(fixture.hostAuth, secret);
    await symlink('/wrong/auth.json', fixture.link);
    assert.equal(await visibilityHostIntact(fixture, secret), false);
    await writeFile(fixture.hostAuth, 'changed');
    assert.equal(await visibilityHostIntact(fixture, secret), false);
    assert.equal(await aliasRetired(join(temporary, 'home/codex/tmp/arg0/codex-arg0gone'), temporary), true);
    assert.equal(await aliasRetired('/tmp/other/codex-arg0gone', temporary), false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('only complete four-read lifecycle with owned stop can report a sampled read result', () => {
  const state = { turnComplete: true, requestCount: 9, completed: 8, items: new Map([0, 1, 2, 3].map(i => [i, {}])),
    interactions: new Map([0, 1, 2, 3].map(i => [i, {}])), sessions: [1234, 2345, 3456, 4567],
    liveSession: null, cleanupIssued: false, error: null, failure: null };
  const report = { status: 'native_turn_observed', transportCloseConfirmed: true, hostExitObserved: true,
    helperAliasRetired: true, postStopCanariesIntact: true,
    observations: ['workspace', 'direct', 'symlink', 'proc'].flatMap((kind, index) => [
      { kind, stage: 'live' }, { kind, stage: 'terminal', category: index === 0 ? 'workspace_read' : 'denied' }]) };
  assert.equal(visibilityFinalStatus(state, report, null, false), 'sampled_tty_reads_denied');
  assert.equal(visibilityFinalStatus({ ...state, failure: 'protected_bytes_visible' }, report, null, false),
    'protected_bytes_visible');
  assert.equal(visibilityFinalStatus({ ...state, sessions: [1234, 2345, 3456, 3456] }, report, null, false),
    'sequence_incomplete');
  assert.equal(visibilityFinalStatus({ ...state, cleanupIssued: true }, report, null, false), 'sequence_incomplete');
  assert.equal(visibilityFinalStatus(state, { ...report, observations: report.observations.slice(0, 6) }, null, false),
    'sequence_incomplete');
  assert.equal(visibilityFinalStatus(state, { ...report, transportCloseConfirmed: false }, null, false),
    'transport_stop_unconfirmed');
  assert.equal(visibilityFinalStatus(state, { ...report, helperAliasRetired: false }, null, false),
    'helper_alias_not_retired');
  assert.equal(visibilityFinalStatus(state, report, 'protocol_failure', false), 'native_failed_before_stop');
});
