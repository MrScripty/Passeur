import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const compiled = process.env.PASSEUR_NATIVE_BUILD ?? resolve(root, '.passeur-native');
const p = await import(pathToFileURL(resolve(compiled, 'src/agents/codex/protocol.js')).href);
const expectCode = (code) => (error) => error?.code === code;
test('account and tool isolation require explicit native facts', () => {
  p.assertAccount({ requiresOpenaiAuth: true, account: { type: 'chatgpt' } });
  assert.throws(() => p.assertAccount({ requiresOpenaiAuth: true, account: { type: 'apiKey' } }), expectCode('CODEX_AUTH_UNAVAILABLE'));
  const config = { features: { multi_agent: false, apps: false, plugins: false }, mcp_servers: {}, web_search: 'disabled', forced_login_method: 'chatgpt' };
  p.assertConfiguration({ config });
  assert.throws(() => p.assertConfiguration({ config: { ...config, mcp_servers: { passeur: {} } } }), expectCode('CODEX_ISOLATION_UNAVAILABLE'));
  p.assertNoMcp({ data: [], nextCursor: null });
  assert.throws(() => p.assertNoMcp({ data: [], nextCursor: 'more' }), expectCode('CODEX_ISOLATION_UNAVAILABLE'));
});
test('selected model, human approval and sandbox have independent postconditions', () => {
  const response = { thread: { id: 't' }, model: 'selected', modelProvider: 'openai', cwd: '/workspace', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false } };
  assert.deepEqual(p.threadStarted(response, '/workspace', 'selected', false), { threadId: 't', reportedModel: 'selected' });
  for (const changes of [{ model: 'fallback' }, { approvalsReviewer: 'auto' }, { cwd: '/other' }, { sandbox: { ...response.sandbox, writableRoots: ['/'] } }]) {
    assert.throws(() => p.threadStarted({ ...response, ...changes }, '/workspace', 'selected', false), expectCode('CODEX_CONFIGURATION_MISMATCH'));
  }
});
test('approval rejects stale identity and persistent or broadened authority', () => {
  const params = { threadId: 't', turnId: 'u', itemId: 'i', command: 'git status', cwd: '/workspace', kind: 'command', environmentId: null };
  assert.equal(p.approval(params, 't', 'u', '/workspace', 'item/commandExecution/requestApproval').command, 'git status');
  assert.equal(p.approval({ ...params, environmentId: 'local' }, 't', 'u', '/workspace', 'item/commandExecution/requestApproval').command, 'git status');
  // A proposal is metadata; the response remains a decision on this one command.
  assert.equal(p.approval({ ...params, proposedExecpolicyAmendment: ['git', 'status'] }, 't', 'u', '/workspace', 'item/commandExecution/requestApproval').command, 'git status');
  assert.throws(() => p.approval({ ...params, turnId: 'old' }, 't', 'u', '/workspace', 'item/commandExecution/requestApproval'), expectCode('CODEX_CORRELATION_INVALID'));
  for (const changes of [{ proposedNetworkPolicyAmendments: [{ host: 'example.org', action: 'allow' }] }, { networkApprovalContext: {} }, { grantRoot: '/' }, { cwd: '/other' }]) {
    assert.throws(() => p.approval({ ...params, ...changes }, 't', 'u', '/workspace', 'item/commandExecution/requestApproval'), expectCode('CODEX_APPROVAL_UNSUPPORTED'));
  }
  assert.throws(() => p.approval({ ...params, environmentId: 'secret-environment' }, 't', 'u', '/workspace', 'item/commandExecution/requestApproval'),
    (error) => error?.code === 'CODEX_APPROVAL_UNSUPPORTED' && error.message.includes('environmentId') && !error.message.includes('secret-environment'));
});
test('terminal status is never inferred from a report or arbitrary response', () => {
  assert.equal(p.terminalTurn({ threadId: 't', turn: { id: 'u', status: 'failed', error: { message: 'native' } } }, 't', 'u'), 'failed');
  assert.throws(() => p.terminalTurn({ threadId: 't', turn: { id: 'u', status: 'completed', error: {} } }, 't', 'u'), expectCode('CODEX_PROTOCOL_INVALID'));
  assert.throws(() => p.terminalTurn({ threadId: 't', turn: { id: 'other', status: 'completed', error: null } }, 't', 'u'), expectCode('CODEX_CORRELATION_INVALID'));
});
