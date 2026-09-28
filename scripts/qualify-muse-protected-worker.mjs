// Fixture-only, no-account Coordinator worker. The caller owns the accepted task lifetime.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareSandbox, probeBubblewrap } from './experiment-worker-sandbox.mjs';
import { runStatusPhase, captureHostIdentities, verifyHostStop,
  parseBubblewrapStatus, startHostSentinel, shellProbeCommand, validateShellReady,
} from './qualify-muse-sandbox-transport.mjs';
import { stageNativeRuntime, startNativeUpstream, startBroker, relaySandboxConfig,
} from './qualify-muse-credential-relay.mjs';

const GUEST_RUNTIME = '/mounts/runtime';
const NATIVE_EXE = `${GUEST_RUNTIME}/muse-bin-1.4.0-R4302.1`;
const SUPERVISOR_EXE = `${GUEST_RUNTIME}/node`;

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

export function protectedMuseWorker({ muse = '/home/jeremy/.local/bin/muse',
  stage = stageNativeRuntime, sentinelStart = startHostSentinel,
  upstreamStart = startNativeUpstream, brokerStart = startBroker,
  prepare = prepareSandbox, probe = probeBubblewrap, launch = runStatusPhase,
  capture = captureHostIdentities, verifyStop = verifyHostStop,
  validateReady = validateShellReady,
  onPending = async () => undefined,
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
        stopObservation;
      let hostStarted = false;
      let token;
      let cancelled = false;
      let nativeAbort = new AbortController();
      let sourceFailure;
      const attended = promise => sourceFailure ? Promise.race([promise, sourceFailure]) : promise;
      const cancel = () => { cancelled = true; nativeAbort.abort(); host?.cancelTask(); };
      input.signal.addEventListener('abort', cancel, { once: true });
      try {
        await Promise.all([home, protectedRoot, socketDirectory].map(path => mkdir(path, { mode: 0o700 })));
        token = randomBytes(12).toString('hex');
        await writeFile(join(protectedRoot, token), 'protected-no-account-canary',
          { mode: 0o600, flag: 'wx' });
        await symlink(protectedRoot, join(input.workspace, 'protected-link'));
        const runtime = await stage(runtimeRoot, muse);
        sentinel = await sentinelStart();
        const runId = `run_${randomBytes(12).toString('hex')}`;
        const bearer = randomBytes(32).toString('hex');
        upstream = await upstreamStart({ bearer, workspace: input.workspace,
          protectedRoot, canaryToken: token, hostPort: sentinel.port, shell: true });
        broker = await brokerStart({ socketPath: join(socketDirectory, 'relay.sock'),
          upstreamOrigin: upstream.origin, runId, bearer, profile: 'native-shell', workspace: input.workspace });
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
          throw fault('NATIVE_TASK_OUTCOME_UNEXPECTED',
            'native guest produced an outcome while task-owned permission was pending');
        });
        hostOutcome.catch(() => undefined);
        const hostFailure = Promise.race([hostOutcome, hostExit]);
        hostFailure.catch(() => undefined);
        const [ready, status] = await attended(Promise.race([
          Promise.all([host.ready, host.liveStatus]), hostFailure]));
        validateReady({ ...ready, providerRequests: upstream.provider.requests },
          input.workspace, sentinel.port, { outerOnly: true });
        const command = shellProbeCommand(input.workspace, protectedRoot, token);
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
        // The broker owns pending identity. A host presentation may disappear while this waits.
        // This prerequisite never supplies or dispatches a permission choice.
        const pending = input.approve(approval, AbortSignal.any([input.signal, nativeAbort.signal]));
        pending.catch(() => undefined);
        Promise.resolve().then(() => onPending({ taskId: input.task_id, runId, checkpoint,
          approval, root, runtimeRoot, processIdentities: {
            wrapper: captured.wrapper, statusChild: captured.statusChild,
            native: captured.native, pidns: captured.pidns,
          } })).catch(() => undefined);
        const unexpected = pending.then(async () => {
          try { await input.onEvent({ kind: 'runtime_unknown', reason: 'NATIVE_APPROVAL_DELIVERY_UNKNOWN' }); }
          catch { /* The typed failure still prevents a native-delivery claim. */ }
          throw fault('NATIVE_APPROVAL_DELIVERY_UNKNOWN',
            'human answer intent was retained but this pending-only fixture did not dispatch native approval');
        });
        await attended(Promise.race([unexpected, hostFailure]));
      } catch (cause) { error = cause; }
      finally {
        nativeAbort.abort();
        input.signal.removeEventListener('abort', cancel);
        if (host && !cancelled) host.cancelTask();
        if (host) {
          const finished = await within(host.finished, 10_000, 'NATIVE_TASK_STOP_UNCONFIRMED')
            .catch(cause => { error ??= cause; return null; });
          if (captured) {
            try { if (finished) {
              const stop = await verifySettledStop(verifyStop, captured,
                parseBubblewrapStatus(finished.statusLines), finished);
              stopProof = stop.proof;
              stopObservation = stop.observation;
            } }
            catch (cause) { stopError = cause; stopObservation = cause.stopObservation;
              error ??= cause; }
          }
        }
        if (captured) await captured.fd.close().catch(() => undefined);
        for (const resource of [broker, upstream, sentinel]) if (resource)
          await within(resource.close(), 5_000, 'NATIVE_TASK_RESOURCE_STOP_UNCONFIRMED')
            .catch(cause => { error ??= cause; });
      }
      if (token && await readFile(join(protectedRoot, token), 'utf8').catch(() => null) !==
          'protected-no-account-canary')
        error ??= fault('NATIVE_TASK_CANARY_INVALID', 'protected host canary changed');
      if (await lstat(join(input.workspace, 'shell-canary')).then(() => true, cause =>
        cause.code === 'ENOENT' ? false : true))
        error ??= fault('NATIVE_TASK_SHELL_EFFECT', 'shell effect appeared without a dispatched approval');
      return stoppedResult(cancelled ? 'cancelled' : 'failed', stopProof, error,
        hostStarted, [root, runtimeRoot], stopError, stopObservation);
    } };
}
