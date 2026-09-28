// Fixture-only, no-account Coordinator worker. The caller owns the accepted task lifetime.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { prepareSandbox, probeBubblewrap } from './experiment-worker-sandbox.mjs';
import { runStatusPhase, captureHostIdentities, verifyHostStop,
  parseBubblewrapStatus, startHostSentinel, shellProbeCommand, shellCommitCommand,
  validateShellReady, readTaskReminderJournal, fixedVerificationPayloadSha256,
} from './qualify-muse-sandbox-transport.mjs';
import { stageNativeRuntime, startNativeUpstream, startBroker, relaySandboxConfig,
} from './qualify-muse-credential-relay.mjs';

const GUEST_RUNTIME = '/mounts/runtime';
const NATIVE_EXE = `${GUEST_RUNTIME}/muse-bin-1.4.0-R4302.1`;
const SUPERVISOR_EXE = `${GUEST_RUNTIME}/node`;
const runFile = promisify(execFile);

function fault(code, message) { return Object.assign(new Error(message), { code }); }
async function within(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fault(code, 'authorized stop did not settle within cleanup bound')), ms);
  })]); } finally { clearTimeout(timer); }
}
function stoppedResult(kind, stopProof, error, hostStarted, roots, stopError, stopObservation) {
  return { status: kind, summary: `${kind === 'cancelled' ?
    'Explicit task cancellation stopped the protected native fixture' :
    'Protected native fixture ended before a qualified task result'}; retained roots: ${roots.join(', ')}${
    stopObservation?.firstSurvivor ? `; first stop check: ${stopObservation.firstSurvivor.code}: ${
      stopObservation.firstSurvivor.message}; checks: ${stopObservation.attempts}` : ''}`,
    worker_stop: !hostStarted ? 'not_started' : stopProof?.kind === 'confirmed' ? 'confirmed' : 'unconfirmed',
    worker_assessment: 'unknown',
    blockers: stopError ? [`Native stop verification failed: ${stopError.code ?? 'STOP_UNCONFIRMED'}: ${String(stopError.message).slice(0, 200)}`] : [],
    questions: [], checks: [],
    ...(error ? { error: { code: error.code ?? 'NATIVE_TASK_FAILED',
      message: String(error.message ?? error).slice(0, 300) } } : {}) };
}
export function boundedGuestFailure(output) {
  for (const line of output ?? []) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value?.kind !== 'guest_transport_error' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code ?? '')) continue;
    const bounded = entry => typeof entry === 'string' ? entry.slice(0, 256) : null;
    const observed = value.failureObservation;
    const child = observed?.childLifecycle;
    const generation = entry => Number.isSafeInteger(entry) && entry >= 0 && entry <= 3 ? entry : null;
    return { stage: bounded(value.stage), code: value.code,
      ...(observed && typeof observed === 'object' && !Array.isArray(observed) ?
        { notification: Object.fromEntries(['method', 'kind', 'sessionId', 'turnId',
          'itemId', 'callId', 'status'].map(key => [key, bounded(observed[key])])) } : {}),
      ...(child && typeof child === 'object' && !Array.isArray(child) ?
        { childLifecycle: { attemptedGeneration: generation(child.attemptedGeneration),
          acceptedChildren: generation(child.acceptedChildren),
          priorGeneration: generation(child.priorGeneration),
          priorStatus: ['inProgress', 'completed'].includes(child.priorStatus) ? child.priorStatus : null,
          sameFirstItem: typeof child.sameFirstItem === 'boolean' ? child.sameFirstItem : null } } : {}) };
  }
  return null;
}
export function primaryNativeFailure(error, guestFailure) {
  return guestFailure && ['GUEST_DISCONNECTED', 'GUEST_OUTPUT_INVALID'].includes(error?.code) ?
    fault(guestFailure.code, 'native guest reported an earlier bounded task failure') : error;
}

function boundedReminderRejection(value) {
  if (value?.schemaClass !== 'recognized_reminder' || value.providerResponseIndex !== 3) return null;
  const oneOf = (entry, values) => values.includes(entry) ? entry : null;
  const state = entry => oneOf(entry, ['unseen', 'call-issued', 'result-accepted',
    'shell-result-classifying', 'none-issued', 'second-issued']);
  const reference = entry => oneOf(entry, ['absent', 'invalid', 'foreign',
    'issued_shell_response', 'unissued_shell_response',
    'issued_reminder_response', 'unissued_reminder_response',
    'issued_shell_item', 'unissued_shell_item', 'issued_reminder_item', 'unissued_reminder_item',
    'issued_shell_call', 'unissued_shell_call', 'issued_reminder_call', 'unissued_reminder_call']);
  const count = entry => Number.isSafeInteger(entry) && entry >= 0 && entry <= 262_144 ? entry : null;
  return { providerResponseIndex: 3, relayRequestIndex: null,
    issuanceAtAdmission: { main: state(value.issuanceAtAdmission?.main),
      reminder: state(value.issuanceAtAdmission?.reminder),
      verification: state(value.issuanceAtAdmission?.verification) },
    classificationState: { main: state(value.classificationState?.main),
      reminder: state(value.classificationState?.reminder) },
    schemaClass: 'recognized_reminder',
    predicate: oneOf(value.predicate, ['ordinal_exceeded', 'prior_reminder_issued',
      'prelude_invalid', 'second_admission_conflict', 'second_state_invalid',
      'association_invalid']),
    ordinal: count(value.ordinal), firstPrelude: value.firstPrelude === true,
    previousResponse: reference(value.previousResponse),
    input: { class: oneOf(value.input?.class, ['string', 'array', 'object', 'null',
      'number', 'boolean', 'undefined']), count: count(value.input?.count),
    omittedItems: count(value.input?.omittedItems),
    items: (Array.isArray(value.input?.items) ? value.input.items : []).slice(0, 8)
      .map(item => ({ type: oneOf(item?.type, ['message', 'function_call',
        'function_call_output', 'other', 'string', 'object', 'array', 'null', 'number',
        'boolean', 'undefined']), id: reference(item?.id), callId: reference(item?.callId) })) },
    nativeChildAssociation: 'unknown' };
}

export function nativeFailureArtifact({ taskId, runId, error, guestFailure, upstream, broker,
  finalHost, stopProof, stopError, stopObservation }) {
  const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
  const text = value => typeof value === 'string' ? value.slice(0, 96) : null;
  const artifact = { schemaVersion: 1, taskId, runId,
    primaryCode: code(error?.code), guestFailure,
    relay: { firstFailure: broker?.evidence?.firstFailure ? {
      code: code(broker.evidence.firstFailure.code),
      stage: text(broker.evidence.firstFailure.stage) } : null,
      accepted: broker?.evidence?.accepted ?? null,
      rejected: broker?.evidence?.rejected ?? null },
    provider: { state: upstream?.provider?.state ? {
      main: text(upstream.provider.state.main), reminder: text(upstream.provider.state.reminder),
      active: upstream.provider.state.active ?? null,
      primaryCode: code(upstream.provider.state.primaryCode),
      omittedRequests: upstream.provider.state.omittedRequests ?? null } : null,
      requests: (upstream?.provider?.requests ?? []).slice(0, 8).map(request => ({
        method: text(request.method), path: text(request.path), kind: text(request.kind),
        responseIndex: request.responseIndex ?? null, callId: text(request.callId),
        itemId: text(request.itemId), forCallId: text(request.forCallId),
        rejection: code(request.rejection),
        ...(request.reminderRejection ? {
          reminderRejection: boundedReminderRejection(request.reminderRejection),
          reminderRejectionEvidence: request.reminderRejectionEvidence ? {
            name: request.reminderRejectionEvidence.name ===
              'provider-response-3-reminder-rejection.json' ? request.reminderRejectionEvidence.name : null,
            bytes: Number.isSafeInteger(request.reminderRejectionEvidence.bytes) ?
              request.reminderRejectionEvidence.bytes : null,
            sha256: /^[a-f0-9]{64}$/.test(request.reminderRejectionEvidence.sha256 ?? '') ?
              request.reminderRejectionEvidence.sha256 : null } : null,
          reminderRejectionEvidenceError: request.reminderRejectionEvidenceError ?
            ['NATIVE_REMINDER_EVIDENCE_INVALID', 'NATIVE_REMINDER_EVIDENCE_BUDGET']
              .includes(request.reminderRejectionEvidenceError) ?
              request.reminderRejectionEvidenceError : 'NATIVE_REMINDER_EVIDENCE_WRITE_FAILED' : null,
        } : {}) })) },
    host: finalHost ? { code: finalHost.code, signal: text(finalHost.signal),
      statusClosed: finalHost.statusClosed === true,
      outputKinds: (finalHost.output ?? []).slice(0, 5).map(line => {
        try { const value = JSON.parse(line); return { kind: text(value.kind),
          stage: text(value.stage), code: code(value.code) }; }
        catch { return { kind: 'invalid_json' }; }
      }) } : null,
    stop: { proof: text(stopProof?.kind), error: code(stopError?.code),
      firstSurvivor: code(stopObservation?.firstSurvivor?.code),
      attempts: stopObservation?.attempts ?? null } };
  if (Buffer.byteLength(JSON.stringify(artifact)) > 12_288) {
    artifact.provider.requests = [];
    if (artifact.host) artifact.host.outputKinds = [];
    artifact.truncated = true;
  }
  return artifact;
}
export async function verifySettledStop(verifyStop, captured, status, finished) {
  const deadline = performance.now() + 2_000;
  let firstSurvivor;
  let attempts = 0;
  for (;;) {
    if (performance.now() >= deadline) {
      const expired = fault('NATIVE_TASK_STOP_UNCONFIRMED', 'stop verification deadline elapsed');
      expired.stopObservation = { firstSurvivor, attempts };
      throw expired;
    }
    try {
      attempts++;
      const proof = await within(verifyStop(captured, status, finished, { allowTaskStop: true }),
        Math.max(1, deadline - performance.now()), 'NATIVE_TASK_STOP_UNCONFIRMED');
      if (performance.now() >= deadline) throw fault('NATIVE_TASK_STOP_UNCONFIRMED',
        'stop verification completed after deadline');
      return { proof, observation: { firstSurvivor, attempts } };
    } catch (error) {
      if (error.code === 'STOP_SURVIVOR') firstSurvivor ??= { code: error.code,
        message: String(error.message).slice(0, 200) };
      if (error.code !== 'STOP_SURVIVOR' || performance.now() + 50 >= deadline) {
        error.stopObservation = { firstSurvivor, attempts };
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function inspectTaskFinalAndStop({ finished, shutdownReleased, nativeOutcome,
  frozenRequests, provider, captured, verifyStop }) {
  let semanticError = null;
  let stopError = null;
  let stopProof = null;
  let stopObservation = null;
  try {
    if (shutdownReleased && (!nativeOutcome || finished.code !== 0 || finished.signal !== null ||
        finished.overflow || finished.timedOut || finished.output?.length !== 4 ||
        JSON.stringify(JSON.parse(finished.output[3])) !== JSON.stringify(nativeOutcome) ||
        provider.state?.primaryCode ||
        JSON.stringify(provider.requests) !== JSON.stringify(frozenRequests))) {
      semanticError = fault('NATIVE_TASK_FINAL_INVALID',
        'native final output or frozen provider changed after shutdown');
    }
  } catch { semanticError = fault('NATIVE_TASK_FINAL_INVALID',
    'native final output was malformed after shutdown'); }
  try {
    const stop = await verifySettledStop(verifyStop, captured,
      parseBubblewrapStatus(finished.statusLines), finished);
    stopProof = stop.proof;
    stopObservation = stop.observation;
  } catch (cause) { stopError = cause; stopObservation = cause.stopObservation; }
  return { semanticError, stopError, stopProof, stopObservation };
}

export async function awaitTaskHostFinished(host, { shutdownReleased, priorError, cancelled,
  sourceFailure, gracefulMs = 30_000, cleanupMs = 10_000, diagnosticGraceMs = 0 }) {
  const graceful = shutdownReleased && !priorError && !cancelled;
  const diagnostic = !shutdownReleased && !cancelled && priorError?.code === 'GUEST_DISCONNECTED' &&
    diagnosticGraceMs > 0;
  try {
    const finished = await within(graceful ?
      Promise.race(sourceFailure ? [host.finished, sourceFailure] : [host.finished]) : host.finished,
    graceful ? gracefulMs : diagnostic ? diagnosticGraceMs : cleanupMs,
    graceful ? 'NATIVE_TASK_FINAL_DEADLINE' : diagnostic ? 'NATIVE_TASK_DIAGNOSTIC_DEADLINE' :
      'NATIVE_TASK_STOP_UNCONFIRMED');
    return { finished, error: null, stopError: null };
  } catch (error) {
    let cancelError = null;
    if (shutdownReleased || diagnostic) {
      try { host.cancelTask(); }
      catch (cause) { cancelError = cause; }
    }
    try {
      return { finished: await within(host.finished, cleanupMs, 'NATIVE_TASK_STOP_UNCONFIRMED'),
        error, stopError: cancelError };
    } catch (stopError) { return { finished: null, error,
      stopError: cancelError ?? stopError }; }
  }
}

export function protectedApprovalRequest(handoff, checkpoint, workspace) {
  const approval = handoff?.approval;
  let args;
  try { args = JSON.parse(handoff?.nativeRawArgs); } catch { /* rejected below */ }
  const identity = value => typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value) <= 256 && !value.includes('\0');
  if (handoff?.kind !== 'native_shell_live_approval' ||
      typeof handoff.nativeRawArgs !== 'string' ||
      Buffer.byteLength(handoff.nativeRawArgs) > 65_536 ||
      approval?.sessionId !== checkpoint.sessionId || approval?.turnId !== checkpoint.turnId ||
      approval?.toolName !== 'bash' || !identity(approval.approvalId) ||
      !identity(approval.sessionId) || !identity(approval.turnId) ||
      !identity(approval.toolCallId) ||
      approval.requirementId?.approvalId !== approval.approvalId ||
      !Number.isSafeInteger(approval.requirementId.sourceIndex) ||
      approval.requirementId.sourceIndex < 0 ||
      !Array.isArray(approval.choices) || approval.choices.length === 0 ||
      approval.choices.some(choice => !choice || !identity(choice.choiceId) ||
        typeof choice.label !== 'string' || Buffer.byteLength(choice.label) > 200 ||
        typeof choice.decision !== 'string' || typeof choice.scope !== 'string') ||
      new Set(approval.choices.map(choice => choice.choiceId)).size !== approval.choices.length ||
      typeof workspace !== 'string' ||
      !args || Array.isArray(args) || Object.keys(args).sort().join(',') !== 'command,description' ||
      args.description !== 'Disposable native shell qualification' ||
      handoff.command !== args.command) {
    throw fault('NATIVE_TASK_APPROVAL_INVALID', 'native pending approval differs from the recorded turn or exact shell command');
  }
  const choices = approval.choices.filter(choice => choice.scope === 'once' &&
    ['approved', 'denied', 'abort'].includes(choice.decision));
  if (!choices.length) throw fault('NATIVE_TASK_APPROVAL_UNSUPPORTED',
    'native permission has no once or denial choice supported by the input broker');
  return { id: `${approval.approvalId}:${approval.requirementId.sourceIndex}`,
    tool: 'muse.bash', raw_args: handoff.nativeRawArgs,
    subject: { session_id: approval.sessionId, turn_id: approval.turnId,
      call_id: approval.toolCallId, approval_id: approval.approvalId,
      requirement_id: approval.requirementId, workspace },
    choices: choices.map(choice => ({ id: choice.choiceId,
      label: choice.label, decision: choice.decision === 'abort' ? 'denied' : choice.decision,
      scope: choice.scope })) };
}

export function nativeTaskDecision(handoff, checkpoint, answer) {
  const choice = handoff?.approval?.choices?.find(value => value.choiceId === answer?.choice_id);
  if (!choice || choice.scope !== 'once' || !['approved', 'denied', 'abort'].includes(choice.decision) ||
      handoff.approval.sessionId !== checkpoint.sessionId ||
      handoff.approval.turnId !== checkpoint.turnId) {
    throw fault('NATIVE_TASK_DECISION_INVALID', 'human choice differs from the current native requirement');
  }
  return { kind: 'choice', handoffId: handoff.handoffId,
    sessionId: checkpoint.sessionId, turnId: checkpoint.turnId,
    callId: handoff.approval.toolCallId, approvalId: handoff.approval.approvalId,
    requirementId: handoff.approval.requirementId, choiceId: choice.choiceId };
}

export function settledCommitOutcome(outcome, checkpoint, handoff, dispatchedChoiceId,
  journal = null) {
  const held = outcome?.held;
  const item = held?.item;
  const commit = item?.commit;
  const responses = outcome?.providerRequests?.filter(value => value.path === '/responses');
  const issued = responses?.filter(value => value.kind === 'native_tool_call');
  const result = responses?.filter(value => value.kind === 'matching_tool_result');
  const reminder = responses?.filter(value => value.kind === 'native_reminder_call');
  const verification = responses?.filter(value => value.kind === 'native_verification_reminder_call');
  const completed = outcome?.observations?.nativeCoverage?.completed;
  const children = outcome?.observations?.nativeCoverage?.children;
  const observedReminders = outcome?.observations?.reminders;
  const expectedChildren = [['skill-reminder', 1], ['skill-reminder', 2], ['verify-reminder', 1]];
  const completeChildren = Array.isArray(children) && children.length === 3 &&
    children.every((child, index) => child?.generationId === expectedChildren[index][1] &&
      child.reminderAgentId === expectedChildren[index][0] && child.turnId === checkpoint.turnId &&
      child.status === 'completed' && child.callId == null &&
      [child.itemId, child.childSessionId, child.taskId].every(value =>
        typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')) &&
      children.slice(0, index).every(prior => prior.itemId !== child.itemId &&
        prior.childSessionId !== child.childSessionId && prior.taskId !== child.taskId));
  const nativeReminderBranch = Array.isArray(reminder) && reminder.length === 2 &&
    Array.isArray(verification) && verification.length === 1 &&
    Array.isArray(observedReminders) && observedReminders.length <= 3 && completeChildren;
  if (outcome?.kind !== 'native_shell_held_decided' || held?.kind !== 'decided' ||
      outcome.sessionId !== checkpoint.sessionId || outcome.turnId !== checkpoint.turnId ||
      held.presentation?.handoffId !== handoff.handoffId ||
      held.decision?.choice?.decision !== 'approved' ||
      held.decision.choice.choiceId !== dispatchedChoiceId ||
      held.decision.ack?.status !== 'accepted' || held.decision.ack?.terminal !== true ||
      held.resolved?.kind !== 'approval/resolved' ||
      held.resolved.approvalId !== handoff.approval.approvalId ||
      held.resolved.decidedByCommandId !== held.decision.commandId ||
      held.resolved.decision !== 'approved' || held.resolved.resolvedBy !== 'user' ||
      item?.callId !== handoff.approval.toolCallId || item.turnId !== checkpoint.turnId ||
      item.tool !== 'bash' || item.status !== 'completed' ||
      item.outputMarkers !== true || item.workspaceReportedWritten !== true ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit ?? '') ||
      held.terminal?.kind !== 'turn_completed' ||
      held.terminal.turnId !== checkpoint.turnId ||
      held.terminal.sessionId !== checkpoint.sessionId ||
      held.terminal.terminal !== 'completed' ||
      outcome.observations?.approvals?.length !== 1 ||
      outcome.observations?.items?.length !== 1 ||
      outcome.observations.items[0].itemId !== item.itemId ||
      !Array.isArray(completed) || !Array.isArray(children) ||
      !Array.isArray(observedReminders) ||
      completed.length !== 1 + observedReminders.length ||
      !nativeReminderBranch ||
      completed.filter(value => value.callId === item.callId && value.itemId === item.itemId &&
        value.turnId === checkpoint.turnId && value.status === 'completed').length !== 1 ||
      children.some(value => value.turnId !== checkpoint.turnId ||
        value.status !== 'completed' || typeof value.itemId !== 'string' ||
        !value.itemId || value.itemId.length > 256 || value.callId != null ||
        completed.some(operation => operation.itemId === value.itemId)) ||
      observedReminders.some(value => value.turnId !== checkpoint.turnId ||
        value.status !== 'completed' || value.payloadMatch !== true ||
        value.tool !== 'submit_reminder_decision' ||
        ![...reminder, ...verification].some(request =>
          request.callId === value.callId) ||
        !completed.some(operation => operation.callId === value.callId &&
          operation.itemId === value.itemId && operation.turnId === value.turnId &&
          operation.status === 'completed')) ||
      observedReminders.some((value, index) => observedReminders.slice(0, index).some(prior =>
        prior.callId === value.callId || prior.itemId === value.itemId)) ||
      completed.some(value => value.callId !== item.callId &&
        !observedReminders.some(reminderItem => reminderItem.callId === value.callId &&
          reminderItem.itemId === value.itemId)) ||
      item.commandMatch !== true ||
      item.outputShape?.sha256 !== result?.[0]?.outputMarkers?.innerOutputSha256 ||
      !Array.isArray(responses) || responses.length !==
        issued.length + result.length + reminder.length + verification.length ||
      outcome.providerRequests.filter(value => value.method === 'GET' &&
        value.path === '/muse-code/models' && value.kind === undefined).length < 1 ||
      outcome.providerRequests.some(value => value.path !== '/responses' &&
        (value.method !== 'GET' || value.path !== '/muse-code/models' || value.kind !== undefined)) ||
      issued.length !== 1 || result.length !== 1 || reminder.length !== 2 ||
      verification.length !== 1 ||
      reminder.some((request, index) => request.callId !==
          (index === 0 ? 'call_native_reminder_1' : 'call_native_reminder_2') ||
        request.itemId !== (index === 0 ? 'fc_native_reminder_1' : 'fc_native_reminder_2') ||
        request.responseId !== (index === 0 ? 'resp_native_reminder_1' : 'resp_native_reminder_2') ||
        request.ordinal !== index + 1 || request.model !== 'fixture-native-shell' ||
        index === 1 && (request.payloadSha256 !== reminder[0].payloadSha256 ||
          request.nativeChildAssociation !== 'unknown')) ||
      verification[0].callId !== 'call_native_verify_reminder_1' ||
      verification[0].itemId !== 'fc_native_verify_reminder_1' ||
      verification[0].responseId !== 'resp_native_verify_reminder_1' ||
      verification[0].model !== 'fixture-native-shell' ||
      verification[0].nativeChildAssociation !== 'unknown' ||
      verification[0].verificationSchema?.selectedComplete !== true ||
      verification[0].verificationSchema?.identityValid !== true ||
      verification[0].association?.previousResponse !== 'absent' ||
      verification[0].association?.httpRelation !== 'unknown' ||
      verification[0].association?.inputCount !== 1 ||
      verification[0].association?.omittedItems !== 0 ||
      verification[0].payloadSha256 !== fixedVerificationPayloadSha256() ||
      issued[0].callId !== item.callId || issued[0].itemId !== 'fc_native_shell_1' ||
      result[0].forCallId !== item.callId ||
      result[0].outputMarkers?.commit !== commit ||
      result[0].outputMarkers?.innerOutputSha256 !== item.outputShape?.sha256 ||
      !result[0].resultEvidence ||
      responses.indexOf(issued[0]) >= responses.indexOf(result[0]) ||
      responses.indexOf(reminder[0]) >= responses.indexOf(reminder[1]) ||
      responses.indexOf(result[0]) >= responses.indexOf(verification[0]) ||
      responses.indexOf(reminder[1]) >= responses.indexOf(verification[0]) ||
      outcome.providerRequests.some(value => value.rejection !== undefined) ||
      Object.values(outcome.observations?.omitted ?? {}).some(value => value !== 0) ||
      outcome.observations?.protocolErrors?.length !== 0) {
    throw fault('NATIVE_TASK_SETTLEMENT_INVALID', 'native shell lacks one correlated approval, tool and completed turn');
  }
  if (journal?.kind !== 'native_task_reminder_journal_joined' ||
      journal.sessionId !== checkpoint.sessionId || journal.turnId !== checkpoint.turnId ||
      !Array.isArray(journal.joins) || journal.joins.length !== children.length ||
      journal.joins.some((join, index) => join.reminderAgentId !== expectedChildren[index][0] ||
        join.generationId !== expectedChildren[index][1] ||
        join.callId !== [...reminder, ...verification][index].callId ||
        join.childSessionId !== children[index].childSessionId ||
        join.taskId !== children[index].taskId)) {
    throw fault('NATIVE_TASK_REMINDER_ASSOCIATION_UNKNOWN',
      'native parent journal did not bind each issued reminder to its child');
  }
  return commit;
}

export async function verifyStoppedPrivateCommit(input, commit) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit ?? '')) {
    throw fault('NATIVE_TASK_COMMIT_INVALID', 'native commit has no exact object identity');
  }
  const view = input.private_git.view;
  const head = (await readFile(join(view.private_common_dir, view.admin_relative, 'HEAD'), 'utf8')).trim();
  if (!/^ref: refs\/heads\/[A-Za-z0-9/_-]+$/.test(head) || head.includes('..')) {
    throw fault('NATIVE_TASK_COMMIT_INVALID', 'private task HEAD is not an owned branch');
  }
  const privateHead = (await readFile(join(view.private_common_dir, head.slice(5)), 'utf8')).trim();
  if (privateHead !== commit) throw fault('NATIVE_TASK_COMMIT_INVALID',
    'native reported commit differs from stopped private branch');
  const git = async (...args) => (await runFile('git', [`--git-dir=${view.private_common_dir}`, ...args],
    { encoding: 'utf8', maxBuffer: 4096, timeout: 5_000 })).stdout;
  const [metadata, names, bytes] = await Promise.all([
    git('show', '-s', '--format=%P%n%T', commit),
    git('diff-tree', '--no-commit-id', '--name-only', '-r', commit),
    git('show', `${commit}:qualified-change.txt`),
  ]);
  const [parent, tree] = metadata.trim().split('\n');
  if (parent !== input.request.base_commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree ?? '') ||
      names !== 'qualified-change.txt\n' || bytes !== 'native committed change\n') {
    throw fault('NATIVE_TASK_COMMIT_INVALID', 'private commit ancestry, tree or file bytes differed');
  }
  return { commit, tree };
}

export function protectedMuseWorker({ muse = '/home/jeremy/.local/bin/muse',
  stage = stageNativeRuntime, sentinelStart = startHostSentinel,
  upstreamStart = startNativeUpstream, brokerStart = startBroker,
  prepare = prepareSandbox, probe = probeBubblewrap, launch = runStatusPhase,
  capture = captureHostIdentities, verifyStop = verifyHostStop,
  validateReady = validateShellReady,
  commitTask = false,
  onPending = async () => undefined,
  onRetained = async () => undefined,
} = {}) {
  return { private_git: { schema_version: 1, mount_kind: 'canonical_common_dir' },
    async run(input) {
      if (!input?.private_git || input.private_git.mount_kind !== 'canonical_common_dir' ||
          input.private_git.schema_version !== 1 || typeof input.onEvent !== 'function' ||
          typeof input.approve !== 'function' || !input.signal ||
          input.signal.aborted || typeof input.workspace !== 'string' ||
          !input.workspace.startsWith('/tmp/')) {
        throw fault('NATIVE_TASK_INPUT_INVALID', 'protected worker needs one live Coordinator-owned private task');
      }
      const view = input.private_git.view;
      const controlRoot = dirname(view.private_common_dir);
      const root = await mkdtemp(join(tmpdir(), 'passeur-muse-protected-worker-'));
      const runtimeRoot = await mkdtemp('/dev/shm/passeur-muse-protected-runtime-');
      const home = join(root, 'home'), protectedRoot = join(root, 'protected');
      const socketDirectory = join(root, 'socket');
      let sentinel, upstream, broker, host, captured, error, checkpoint, stopProof, stopError,
        stopObservation, approvedCommit, nativeOutcome, frozenRequests, finalHost, guestFailure, runId,
        journalIdentity, journalSnapshot;
      let hostStarted = false;
      let decisionSent = false;
      let shutdownReleased = false;
      let dispatchedChoiceId;
      let token;
      let cancelled = false;
      let nativeAbort = new AbortController();
      let sourceFailure;
      const attended = promise => sourceFailure ? Promise.race([promise, sourceFailure]) : promise;
      const cancel = () => { cancelled = true; nativeAbort.abort(); host?.cancelTask(); };
      input.signal.addEventListener('abort', cancel, { once: true });
      try {
        await onRetained({ taskId: input.task_id, root, runtimeRoot });
        await Promise.all([home, protectedRoot, socketDirectory].map(path => mkdir(path, { mode: 0o700 })));
        token = randomBytes(12).toString('hex');
        await writeFile(join(protectedRoot, token), 'protected-no-account-canary',
          { mode: 0o600, flag: 'wx' });
        await symlink(protectedRoot, join(input.workspace, 'protected-link'));
        const runtime = await stage(runtimeRoot, muse);
        sentinel = await sentinelStart();
        runId = `run_${randomBytes(12).toString('hex')}`;
        const bearer = randomBytes(32).toString('hex');
        upstream = await upstreamStart({ bearer, workspace: input.workspace,
          protectedRoot, canaryToken: token, hostPort: sentinel.port, shell: true,
          taskCommit: commitTask });
        broker = await brokerStart({ socketPath: join(socketDirectory, 'relay.sock'),
          upstreamOrigin: upstream.origin, runId, bearer, profile: 'native-shell', workspace: input.workspace,
          ...(commitTask ? { shellCommand: shellCommitCommand(input.workspace, protectedRoot, token) } : {}) });
        sourceFailure = Promise.race([
          upstream.provider.rejection.then(event => { throw fault(event.code,
            'host synthetic provider rejected native task traffic'); }),
          broker.failure.then(event => { throw fault(event.code,
            'credential relay rejected native task traffic'); }),
        ]);
        sourceFailure.catch(() => undefined);
        const prepared = prepare(relaySandboxConfig({ workspace: input.workspace, runtime, home,
          protectedRoot, socketDirectory, privateGit: { controlRoot, view } }),
        [SUPERVISOR_EXE, `${GUEST_RUNTIME}/qualify-muse-credential-relay.mjs`, '--guest-native']);
        probe();
        input.signal.throwIfAborted();
        hostStarted = true;
        host = launch(prepared, { phase: 'outer-held-shell', taskOwned: true,
          taskCommit: commitTask,
          turnCheckpointId: randomUUID(), workspace: input.workspace,
          protectedRoot, canaryToken: token, hostPort: sentinel.port, runId });
        if (cancelled) host.cancelTask();
        const hostExit = host.finished.then(() => { throw fault('NATIVE_TASK_HOST_EXIT',
          'native guest exited before pending permission was retained'); });
        hostExit.catch(() => undefined);
        const hostOutcome = host.outcome.then(result => {
          if (result?.kind === 'guest_transport_error' &&
              /^[A-Z0-9_]{1,64}$/.test(result.code ?? '')) {
            throw fault(result.code, 'native guest reported an authoritative task failure');
          }
          if (commitTask && decisionSent && result?.kind === 'native_shell_held_decided') return result;
          throw fault('NATIVE_TASK_OUTCOME_UNEXPECTED', 'native guest produced an unexpected outcome');
        });
        hostOutcome.catch(() => undefined);
        const hostFailure = Promise.race([hostOutcome, hostExit]);
        hostFailure.catch(() => undefined);
        const [ready, status] = await attended(Promise.race([
          Promise.all([host.ready, host.liveStatus]), hostFailure]));
        validateReady({ ...ready, providerRequests: upstream.provider.requests },
          input.workspace, sentinel.port, { outerOnly: true });
        const command = (commitTask ? shellCommitCommand : shellProbeCommand)(input.workspace, protectedRoot, token);
        if (ready.commandSha256 !== createHash('sha256').update(command).digest('hex'))
          throw fault('NATIVE_TASK_COMMAND_INVALID', 'ready native shell command differs from fixed host command');
        if (!status.child || status.exit !== null) throw fault('NATIVE_TASK_HOST_INVALID', 'native task host lacks a live child');
        captured = await capture(host.pid, status.child, ready.nativeIdentity.start,
          NATIVE_EXE, SUPERVISOR_EXE);
        if (captured.native.nspid.at(-1) !== ready.nativeIdentity.pid ||
            captured.native.netns !== ready.nativeNamespace) {
          throw fault('NATIVE_TASK_HOST_INVALID', 'native identity differs from held namespace');
        }
        host.releaseTurn();
        checkpoint = await attended(Promise.race([host.turnAccepted, hostFailure]));
        await attended(Promise.race([host.recordAndAckTurn(async turn => {
          if (turn.sessionId !== checkpoint.sessionId || turn.turnId !== checkpoint.turnId)
            throw fault('NATIVE_TASK_TURN_INVALID', 'accepted turn changed before durable event');
          await input.onEvent({ kind: 'turn_started', turn_id: turn.turnId,
            native_session_id: turn.sessionId });
        }), hostFailure]));
        const handoff = await attended(Promise.race([host.handoff, hostFailure]));
        const approval = protectedApprovalRequest(handoff, checkpoint, input.workspace);
        if (handoff.command !== command) throw fault('NATIVE_TASK_COMMAND_INVALID',
          'native approval command differs from fixed host command');
        if (commitTask) {
          const issued = upstream.provider.requests.filter(value => value.kind === 'native_tool_call');
          if (issued.length !== 1 || issued[0].callId !== handoff.approval.toolCallId ||
              issued[0].commandSha256 !== ready.commandSha256) {
            throw fault('NATIVE_TASK_OPERATION_START_MISSING',
              'native approval lacks the provider-issued shell call');
          }
          await input.onEvent({ kind: 'operation_started', id: handoff.approval.toolCallId,
            operation: 'tool' });
        }
        // The broker owns pending identity. A host presentation may disappear while this waits.
        const pending = input.approve(approval, AbortSignal.any([input.signal, nativeAbort.signal]));
        pending.catch(() => undefined);
        Promise.resolve().then(() => onPending({ taskId: input.task_id, runId, checkpoint,
          approval, root, runtimeRoot, processIdentities: {
            wrapper: captured.wrapper, statusChild: captured.statusChild,
            native: captured.native, pidns: captured.pidns,
          } })).catch(() => undefined);
        const unexpected = pending.then(async answer => {
          if (commitTask) {
            const frame = nativeTaskDecision(handoff, checkpoint, answer);
            await host.sendDecision(frame);
            dispatchedChoiceId = frame.choiceId;
            decisionSent = true;
            return await Promise.race([hostOutcome, hostExit]);
          }
          try { await input.onEvent({ kind: 'runtime_unknown', reason: 'NATIVE_APPROVAL_DELIVERY_UNKNOWN' }); }
          catch { /* The typed failure still prevents a native-delivery claim. */ }
          throw fault('NATIVE_APPROVAL_DELIVERY_UNKNOWN',
            'human answer intent was retained but this pending-only fixture did not dispatch native approval');
        });
        const outcome = await attended(Promise.race([unexpected, hostFailure]));
        if (commitTask) {
          if (!decisionSent) throw fault('NATIVE_TASK_OUTCOME_EARLY',
            'native outcome preceded the retained human decision');
          if (upstream.provider.state?.active !== 0) throw fault('NATIVE_TASK_PROVIDER_ACTIVE',
            'native provider still has an admitted request');
          await attended(broker.close());
          const brokerEvidence = broker.evidence;
          broker = undefined;
          await attended(upstream.provider.freeze());
          frozenRequests = structuredClone(upstream.provider.requests);
          if (upstream.provider.state?.primaryCode || upstream.provider.state?.failed ||
              upstream.provider.state?.omittedRequests !== 0 || brokerEvidence?.firstFailure ||
              brokerEvidence?.rejected !== 0 ||
              brokerEvidence?.accepted !== frozenRequests.length ||
              upstream.seen?.length !== frozenRequests.length ||
              upstream.seen.some(value => !value.correctBearer || !value.dummyAbsent)) {
            throw fault('NATIVE_TASK_PROVIDER_INVALID', 'host provider or credential relay evidence differed');
          }
          nativeOutcome = outcome;
          const children = outcome.observations?.nativeCoverage?.children ?? [];
          const reminder = frozenRequests.filter(request => request.kind === 'native_reminder_call');
          const verification = frozenRequests.filter(request =>
            request.kind === 'native_verification_reminder_call');
          const callByChild = new Map([
            ['skill-reminder:1', reminder[0]?.callId],
            ['skill-reminder:2', reminder[1]?.callId],
            ['verify-reminder:1', verification[0]?.callId],
          ]);
          journalIdentity = children.length ? { path: ready.metadata.durableLogPath,
            sessionId: checkpoint.sessionId,
              turnId: checkpoint.turnId, expected: children.map(child => ({
                reminderAgentId: child.reminderAgentId,
                generationId: child.generationId, childSessionId: child.childSessionId,
                taskId: child.taskId,
                callId: callByChild.get(`${child.reminderAgentId}:${child.generationId}`) })) } : null;
          journalSnapshot = journalIdentity ? await readTaskReminderJournal(root,
            journalIdentity.path, journalIdentity) : null;
          approvedCommit = settledCommitOutcome({ ...outcome, providerRequests: frozenRequests },
            checkpoint, handoff, dispatchedChoiceId, journalSnapshot);
          host.releaseShutdown();
          shutdownReleased = true;
        }
      } catch (cause) { error = cause; }
      finally {
        nativeAbort.abort();
        if (host && !cancelled && !shutdownReleased &&
            !(commitTask && error?.code === 'GUEST_DISCONNECTED')) host.cancelTask();
        if (host) {
          const awaited = await awaitTaskHostFinished(host, { shutdownReleased,
            priorError: error, cancelled, sourceFailure,
            diagnosticGraceMs: commitTask && error?.code === 'GUEST_DISCONNECTED' ? 7_000 : 0 });
          const finished = awaited.finished;
          finalHost = finished;
          guestFailure = boundedGuestFailure(finished?.output);
          error = primaryNativeFailure(error, guestFailure);
          error ??= awaited.error ?? awaited.stopError;
          stopError ??= awaited.stopError;
          if (captured) {
            if (finished) {
              const inspected = await inspectTaskFinalAndStop({ finished, shutdownReleased,
                nativeOutcome, frozenRequests, provider: upstream.provider, captured, verifyStop });
              error ??= inspected.semanticError ?? inspected.stopError;
              stopError ??= inspected.stopError;
              stopProof = inspected.stopProof;
              stopObservation = inspected.stopObservation;
            }
          }
        }
        input.signal.removeEventListener('abort', cancel);
        if (captured) await captured.fd.close().catch(() => undefined);
        for (const resource of [broker, upstream, sentinel]) if (resource)
          await within(resource.close(), 5_000, 'NATIVE_TASK_RESOURCE_STOP_UNCONFIRMED')
            .catch(cause => { error ??= cause; });
        if (commitTask && error) {
          const failureArtifact = nativeFailureArtifact({
            taskId: input.task_id, runId, error, guestFailure, upstream, broker,
            finalHost, stopProof, stopError, stopObservation });
          await writeFile(join(root, 'native-task-failure.json'),
            `${JSON.stringify(failureArtifact)}\n`, { mode: 0o600, flag: 'wx' })
            .catch(() => undefined);
        }
      }
      if (token && await readFile(join(protectedRoot, token), 'utf8').catch(() => null) !==
          'protected-no-account-canary')
        error ??= fault('NATIVE_TASK_CANARY_INVALID', 'protected host canary changed');
      if (!commitTask && await lstat(join(input.workspace, 'shell-canary')).then(() => true, cause =>
        cause.code === 'ENOENT' ? false : true))
        error ??= fault('NATIVE_TASK_SHELL_EFFECT', 'shell effect appeared without a dispatched approval');
      if (commitTask && approvedCommit && !error && stopProof?.kind === 'confirmed') {
        if (journalIdentity) {
          try {
            const finalJournal = await readTaskReminderJournal(root,
              journalIdentity.path, journalIdentity);
            if (JSON.stringify(finalJournal) !== JSON.stringify(journalSnapshot)) {
              throw fault('NATIVE_TASK_REMINDER_ASSOCIATION_UNKNOWN',
                'native parent journal association changed before confirmed stop');
            }
          } catch (cause) { error = cause; }
        }
      }
      if (commitTask && approvedCommit && !error && stopProof?.kind === 'confirmed') {
        if (await readFile(join(input.workspace, 'qualified-change.txt'), 'utf8').catch(() => null) !==
            'native committed change\n') {
          error = fault('NATIVE_TASK_WORKSPACE_INVALID', 'committed workspace bytes differed after native stop');
        }
      }
      if (commitTask && approvedCommit && !error && stopProof?.kind === 'confirmed') {
        try {
          await verifyStoppedPrivateCommit(input, approvedCommit);
          await input.onEvent({ kind: 'operation_finished', id: nativeOutcome.held.item.callId });
          await input.onEvent({ kind: 'turn_settled', turn_id: checkpoint.turnId,
            native_session_id: checkpoint.sessionId });
        } catch (cause) { error = cause; }
      }
      if (commitTask && approvedCommit && !error && stopProof?.kind === 'confirmed') {
        return { status: 'completed', summary: `Native private commit ${approvedCommit} settled and stopped`,
          worker_stop: 'confirmed', worker_assessment: 'unknown', blockers: [], questions: [], checks: [] };
      }
      if (commitTask && error && root) {
        const failureArtifact = nativeFailureArtifact({ taskId: input.task_id, runId,
          error, guestFailure, upstream, broker, finalHost, stopProof, stopError, stopObservation });
        await writeFile(join(root, 'native-task-failure.json'),
          `${JSON.stringify(failureArtifact)}\n`, { mode: 0o600, flag: 'wx' })
          .catch(() => undefined);
      }
      return stoppedResult(cancelled ? 'cancelled' : 'failed', stopProof, error,
        hostStarted, [root, runtimeRoot], stopError, stopObservation);
    } };
}
