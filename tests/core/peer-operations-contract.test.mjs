import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { decodePeerWorkerOperation, decodePeerWorkerOperationResult } from '../../.passeur-core/src/contracts/peer-operations.js';
import { encodePeerResolutionRecord, PEER_RESOLUTION_ACTIONS } from '../../.passeur-core/src/coordination/peer-resolution.js';
import { parseWorkerMessage } from '../../.passeur-core/src/agents/report.js';
import { decodeCoordinationRequest } from '../../.passeur-core/src/contracts/coordination-service.js';

const identity = { task_id: '11111111-1111-4111-8111-111111111111', run_id: '22222222-2222-4222-8222-222222222222',
  control_generation: 3, workspace_id: 'git-worktree-v1:' + 'a'.repeat(64), source_view: '/repo', case_id: '33333333-3333-4333-8333-333333333333' };
const proposal = (action = 'propose') => ({ schema_version: 1, kind: 'peer_resolution_proposal', case_id: identity.case_id,
  case_revision: 4, case_generation: 2, proposal_revision: action === 'propose' ? 1 : 2, evidence_id: 'a'.repeat(64), evidence_revision: 4,
  participants: ['b'.repeat(64), 'c'.repeat(64)], sources: [{ work_id: '44444444-4444-4444-8444-444444444444', work_revision: 1,
    input_oid: 'd'.repeat(40), selected_commit_oid: 'e'.repeat(40) }], scope: [{ kind: 'file', path: 'src/a.ts' }], action,
  resolution_digest: action === 'propose' ? 'f'.repeat(64) : '1'.repeat(64), predecessor_digest: action === 'propose' ? null : 'f'.repeat(64),
  permitted_actions: [...PEER_RESOLUTION_ACTIONS] });

test('a typed current-result producer must supply every field required by persistence', () => {
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '.peer-current-contract.typecheck.ts');
  const source = `
    import type { PeerWorkerOperationResult } from '../../src/contracts/peer-operations.js';
    type Current = Extract<PeerWorkerOperationResult, { kind: 'current' }>;
    declare const valid: Current;
    const accepted: Current = valid;
    declare const withoutCursor: Omit<Current, 'negotiation_cursor'>;
    declare const withoutParticipants: Omit<Current, 'participant_task_ids'>;
    declare const withoutAcknowledgments: Omit<Current, 'acknowledged_task_ids'>;
    const rejectedCursor: Current = withoutCursor;
    const rejectedParticipants: Current = withoutParticipants;
    const rejectedAcknowledgments: Current = withoutAcknowledgments;
  `;
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.core.json');
  assert.ok(configPath);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  assert.deepEqual(parsed.errors, []);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === fixturePath ? ts.createSourceFile(path, source, languageVersion) :
      getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = ((fileExists) => path => path === fixturePath || fileExists(path))(host.fileExists.bind(host));
  host.readFile = ((readFile) => path => path === fixturePath ? source : readFile(path))(host.readFile.bind(host));
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([fixturePath], options, host));
  assert.equal(diagnostics.length, 3, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  for (const [index, field] of ['negotiation_cursor', 'participant_task_ids', 'acknowledged_task_ids'].entries()) {
    assert.equal(diagnostics[index].code, 2322);
    assert.match(ts.flattenDiagnosticMessageText(diagnostics[index].messageText, '\n'), new RegExp(`Property '${field}' is missing`));
  }
});

test('worker operations retain a task-bound identity and reject effect authority', () => {
  const cases = [
    { kind: 'inspect' },
    { kind: 'propose', proposal: proposal() },
    { kind: 'counter_propose', proposal: proposal('counter_propose') },
    { kind: 'acknowledge', note_id: '55555555-5555-4555-8555-555555555555' },
    { kind: 'withdraw', note_id: '55555555-5555-4555-8555-555555555555' },
    { kind: 'await_change', after_case_revision: 4, after_case_generation: 2 },
  ];
  for (const [index, operation] of cases.entries()) {
    const decoded = decodePeerWorkerOperation({ schema_version: 1, ...identity, operation_key: `worker-${index}`, ...operation });
    assert.equal(decoded.task_id, identity.task_id); assert.equal(decoded.case_id, identity.case_id);
  }
  assert.throws(() => decodePeerWorkerOperation({ schema_version: 1, ...identity, operation_key: 'bad', kind: 'apply', application: {} }), { code: 'PEER_OPERATION_UNSUPPORTED' });
  assert.throws(() => decodePeerWorkerOperation({ schema_version: 1, ...identity, operation_key: 'bad', kind: 'inspect', extra: true }), { code: 'PEER_OPERATION_INVALID' });
  assert.throws(() => decodePeerWorkerOperation({ schema_version: 1, ...identity, operation_key: 'bad', kind: 'propose', proposal: proposal('counter_propose') }), { code: 'PEER_OPERATION_INVALID' });
});

test('worker operation results and native dispositions preserve exact operation identity', () => {
  const request = decodePeerWorkerOperation({ schema_version: 1, ...identity, operation_key: 'inspect-1', kind: 'inspect' });
  const result = decodePeerWorkerOperationResult({ ...request, kind: 'current', operation: 'inspect', case_revision: 4, case_generation: 2,
    evidence_id: 'a'.repeat(64), evidence_revision: 4, negotiation_cursor: 'b'.repeat(64),
    proposal_note_id: null, proposal: null, participant_task_ids: [], acknowledged_task_ids: [] });
  assert.equal(result.operation_key, request.operation_key); assert.equal(result.task_id, request.task_id);
  assert.equal(result.negotiation_cursor, 'b'.repeat(64));
  for (const field of ['negotiation_cursor', 'participant_task_ids', 'acknowledged_task_ids']) {
    const missingField = Object.fromEntries(Object.entries(result).filter(([key]) => key !== field));
    assert.throws(() => decodePeerWorkerOperationResult(missingField), { code: 'PEER_OPERATION_INVALID' });
  }
  assert.throws(() => decodePeerWorkerOperationResult({ ...result, acknowledged_task_ids: [identity.task_id] }), { code: 'PEER_OPERATION_INVALID' });
  assert.equal(decodePeerWorkerOperation({ schema_version: 1, ...identity, operation_key: 'wait-cursor', kind: 'await_change',
    after_case_revision: 4, after_case_generation: 2, after_negotiation_cursor: result.negotiation_cursor }).after_negotiation_cursor,
  result.negotiation_cursor);
  const message = parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: 'peer_operation', operation: { schema_version: 1,
    operation_key: 'inspect-1', case_id: identity.case_id, kind: 'inspect' } })}`);
  assert.equal(message.kind, 'peer_operation'); assert.equal(message.operation.kind, 'inspect');
  assert.throws(() => parseWorkerMessage(`PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: 'peer_operation', operation: { schema_version: 1,
    operation_key: 'effect', case_id: identity.case_id, kind: 'apply' } })}`), { code: 'WORKER_MESSAGE_INVALID' });
});

test('public parent coordination remains unable to submit worker operations', () => {
  assert.throws(() => decodeCoordinationRequest({ schema_version: 1, kind: 'command', command: {
    kind: 'peer_operation', operation_key: 'effect', task_id: identity.task_id,
  } }), { code: 'COORDINATION_OPERATION_UNSUPPORTED' });
});
