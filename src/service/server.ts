import { createServer, type Server } from "node:net";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { lstat, unlink, chmod } from "node:fs/promises";
import type { RepositoryRuntime, ResolvedBinding } from "../core/repository-runtime.js";
import type { RuntimeIdentity } from "../contracts/runtime.js";
import type { ResultRequest } from "../contracts/types.js";
import { DescriptorSchema, operationSchemas, responseSchemas, type Arguments, type Operation } from "../contracts/service.js";
import { BridgeError, diagnosticInfo, nativeCode, safeText, type ErrorInfo } from "../core/errors.js";
import { atomicJson } from "../store/task-store.js";
import { authenticateServicePeer } from "./peer-auth.js";
import { routeCoordination } from "./coordination-route.js";
import { decodeCoordinationRequest } from "../contracts/coordination-service.js";
import { assertRequestCapacity, serviceRequestLane, type RequestLane } from "./request-capacity.js";
import { assertElectionGuard, processIdentity } from "./process.js";
import { preparePaths, readDescriptor } from "./bootstrap.js";
import { IpcConnection, type Frame } from "./transport.js";
import type { ClientActor } from "../core/task-control.js";
import { taskReceipt } from "../contracts/tasks.js";
import { textChunk } from "../core/result.js";

type Peer = { connection: IpcConnection; actor?: ClientActor; source?: string; authenticating: boolean; requests: Map<string, { controller: AbortController; lane: RequestLane }> };
const errorValue = (error: unknown) => { const e = diagnosticInfo(error); return { code: e.code.slice(0, 128), message: (e.message || "Service operation failed").slice(0, 2048) }; };
const finalizedErrorValue = (error: ErrorInfo) => ({ code: safeText(error.code, 128),
  message: safeText(error.message || "Service operation failed", 2048) });
/** The elected process owns the runtime. Connection actors own no worker lifetime. */
export async function runRepositoryService(runtime: RepositoryRuntime, binding: ResolvedBinding, identity: RuntimeIdentity, bootstrapInput: NodeJS.ReadableStream = process.stdin): Promise<void> {
  const paths = await preparePaths(binding); await assertElectionGuard(paths.guard);
  const generation = randomUUID(), token = randomBytes(32).toString("hex");
  const peers = new Set<Peer>(), pending = new Set<Promise<unknown>>();
  let reservation = true, published = false, epoch = 0, closing = false, draining = false, emptyCheck = false;
  let finish!: () => void, fail!: (error: unknown) => void;
  const ended = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  ended.catch(() => undefined);
  let stopPromise: Promise<void> | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  const status = () => ({ schema_version: 1 as const, generation, clients: [...peers].filter((p) => p.actor).length,
    admission: draining ? "draining" as const : "open" as const, repository: runtime.status() });
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); epoch++;
    void work.then(() => { pending.delete(work); epoch++; maybeExit(); }, () => { pending.delete(work); epoch++; maybeExit(); });
    return work;
  };
  const cleanupEndpoint = async () => {
    // Only this elected generation may remove its own locator and exact socket inode.
    await assertElectionGuard(paths.guard);
    const current = await readDescriptor(binding);
    if (current?.generation === generation) await unlink(paths.descriptor);
    try {
      const info = await lstat(paths.endpoint);
      if (socketIdentity && info.dev === socketIdentity.dev && info.ino === socketIdentity.ino && info.isSocket()) await unlink(paths.endpoint);
    } catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
  };
  const close = async () => {
    if (closing) return; closing = true; draining = true; epoch++;
    for (const peer of peers) peer.connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...pending]);
    try { await runtime.shutdown(); await cleanupEndpoint(); finish(); }
    catch (error) { fail(error); }
  };
  function maybeExit(): void {
    if (!published || closing || draining || reservation || peers.size || pending.size || emptyCheck) return;
    emptyCheck = true; const observed = epoch;
    void runtime.hasObligations().then((has) => {
      emptyCheck = false;
      if (!has && epoch === observed && !reservation && !peers.size && !pending.size && !draining) void close();
      else if (!has && epoch !== observed) maybeExit();
    }, (error) => { emptyCheck = false; console.error(errorValue(error).code); });
  }
  const beginStop = () => {
    draining = true; epoch++;
    if (!published) return;
    stopPromise ??= (async () => { await runtime.stopAdmission(); await runtime.drain(); await close(); })();
    void stopPromise.catch(fail);
  };
  async function dispatch<K extends Operation>(operation: K, raw: unknown, peer: Peer, signal: AbortSignal): Promise<unknown> {
    const parsed = operationSchemas[operation].safeParse(raw);
    if (!parsed.success) throw new BridgeError("SERVICE_ARGUMENT_INVALID", "The operation payload does not satisfy its complete contract");
    const args = parsed.data;
    const actor = peer.actor!;
    if (draining && (operation === "submit" || operation === "submit_batch" || operation === "submit_coordinated" || operation === "announce" || operation === "prepare")) throw new BridgeError("SERVICE_DRAINING", "Service admission is closed; existing tasks can still be observed and controlled");
    switch (operation) {
      case "status": return status();
      case "prepare": await runtime.prepare(signal); return status();
      case "agents": { const a = args as Arguments<"agents">; return runtime.agents(a.offset, a.limit); }
      case "submit": { const a = args as Arguments<"submit">; return { kind: "accepted", task: await runtime.submit(a.assignment, actor, peer.source!, signal) }; }
      case "submit_coordinated": { const a = args as Arguments<"submit_coordinated">;
        return { kind: "accepted", task: await runtime.submitCoordinated(a, actor, peer.source!, signal) }; }
      case "announce": { const a = args as Arguments<"announce">;
        return runtime.announce(a, actor, peer.source!, signal); }
      case "announcement": { const a = args as Arguments<"announcement">;
        return runtime.announcement(a.id, actor, peer.source!, signal); }
      case "withdraw_announcement": { const a = args as Arguments<"withdraw_announcement">;
        return runtime.withdrawAnnouncement(a.id, a.expected_revision, a.operation_key, actor, peer.source!); }
      case "preflight": { const a = args as Arguments<"preflight">;
        return runtime.preflightCoordinated(a, actor, peer.source!, signal); }
      case "submit_batch": {
        const a = args as Arguments<"submit_batch">, results = [];
        for (const assignment of a.assignments) {
          try { results.push({ request_key: assignment.request_key, task: taskReceipt(await runtime.submit(assignment, actor, peer.source!, signal)) }); }
          catch (error) { results.push({ request_key: assignment.request_key, error: { code: errorValue(error).code.slice(0, 96), message: errorValue(error).message.slice(0, 128) } }); }
        }
        return { results };
      }
      case "tasks": { const a = args as Arguments<"tasks">; return runtime.tasks(actor, a.offset, a.limit, a.request_key); }
      case "wait": { const a = args as Arguments<"wait">; return runtime.waitTask(a.task_id, actor, a.after_revision, a.wait_ms, signal); }
      case "cancel": { const a = args as Arguments<"cancel">; return runtime.cancelTask(a.task_id, actor, a.control_generation, a.operation_key, a.reason); }
      case "attach": {
        // This private command is emitted only after request-associated human confirmation by the trusted front end.
        const a = args as Arguments<"attach">; return runtime.attachTask(a, actor, a.operation_key);
      }
      case "input_claim": { const a = args as Arguments<"input_claim">; return runtime.inputBroker().claim(a.task_id, a.input_id, actor, a.control_generation); }
      case "input_dismiss": { const a = args as Arguments<"input_dismiss">; await runtime.inputBroker().dismiss(a.task_id, a.input_id, actor, a.claim_id); return { kind: "presentation_released" }; }
      case "input_answer": { const a = args as Arguments<"input_answer">; return runtime.inputBroker().answer(a.task_id, a.input_id, actor, a.control_generation, a.claim_id, a.operation_key, a.answer); }
      case "retained": {
        const a = args as Arguments<"retained">;
        let id = a.task_id;
        if (!id) id = await runtime.retainedTaskId(a.request_key!);
        await runtime.authorizeTask(id, actor);
        const request: ResultRequest = { encoding: a.encoding, offset: a.offset, limit: a.limit,
          ...(a.task_id ? { task_id: a.task_id } : { request_key: a.request_key! }), ...(a.section ? { section: a.section } : {}), ...(a.artifact_id ? { artifact_id: a.artifact_id } : {}) };
        const { task_id, buffer } = await runtime.retained(request);
        const chunk = textChunk(buffer, buffer.length, a.encoding);
        return { task_id, offset: a.offset, bytes: chunk.bytes, next_offset: a.offset + chunk.bytes, eof: buffer.length === 0, encoding: a.encoding, content: chunk.content };
      }
      case "structural_report": {
        const a = args as Arguments<"structural_report">;
        return runtime.structuralReport(a.work_id, actor, peer.source!, signal);
      }
      case "structural_detail": {
        const a = args as Arguments<"structural_detail">;
        return runtime.structuralDetail(a.work_id, a.report_id, a.side, a.start_byte, a.end_byte, actor, signal);
      }
      case "structural_refresh": { const a = args as Arguments<"structural_refresh">; return runtime.structuralRefresh(a.work_id, actor, signal); }
      case "structural_observation_status": { const a = args as Arguments<"structural_observation_status">; return runtime.structuralObservationStatus(a.work_id, actor); }
      case "structural_notice_pull": { const a = args as Arguments<"structural_notice_pull">; return runtime.structuralNoticePull(actor, a.cursor, signal); }
      case "structural_notice_ack": { const a = args as Arguments<"structural_notice_ack">; return runtime.structuralNoticeAck(actor, a.notice_id); }
      case "structural_current": return runtime.structuralCurrent(actor);
      case "structural_artifact_report": { const a = args as Arguments<"structural_artifact_report">; return runtime.structuralArtifactReport(actor, a.artifact_id); }
      case "structural_artifact_detail": { const a = args as Arguments<"structural_artifact_detail">;
        return runtime.structuralArtifactDetail(actor, a.artifact_id, a.side, a.start_byte, a.end_byte); }
      case "finalize": {
        const a = args as Arguments<"finalize">;
        for (const op of a.operations) await runtime.authorizeTask(op.task_id, actor);
        const results = (await runtime.finalize(a.operations)).map((entry) => entry.receipt
          ? { task_id: entry.task_id, operation_key: entry.operation_key, state: entry.receipt.state, resource_state: entry.receipt.resource.state }
          : { task_id: entry.task_id, operation_key: entry.operation_key, error: finalizedErrorValue(entry.error!) });
        return { results };
      }
      case "cleanup": { const a = args as Arguments<"cleanup">; await runtime.authorizeTask(a.task_id, actor); await runtime.cleanup(a.task_id); return { kind: "collected" }; }
      case "reconcile": { const a = args as Arguments<"reconcile">; await runtime.reconcile(a.task_id, a.owner, a.reason, actor); return { kind: "reconciled", status: status() }; }
      case "stop": {
        const a = args as Arguments<"stop">;
        for (const id of a.cancel_tasks) {
          const task = await runtime.taskObservation(id, actor);
          await runtime.cancelTask(id, actor, task.control_generation, createHash("sha256").update(JSON.stringify([a.operation_key, id])).digest("hex"), "Explicit operator service stop with named cancellation");
        }
        const outstanding = await runtime.hasObligations();
        // Schedule after the response is queued. Draining does not cancel other owners' work.
        setImmediate(beginStop); return { kind: "draining", outstanding };
      }
    }
    throw new BridgeError("SERVICE_OPERATION_UNSUPPORTED", "Unsupported operation");
  }
  const server: Server = createServer((socket) => {
    if (closing || peers.size >= (runtime.configuredProfile?.execution.max_clients ?? 32)) { socket.destroy(); return; }
    epoch++;
    const peer: Peer = { connection: undefined!, authenticating: false, requests: new Map() };
    const handshakeTimer = setTimeout(() => { if (!peer.actor) peer.connection.close(); }, 10_000);
    const connection = new IpcConnection(socket, async (frame: Frame) => {
      if (frame.kind === "hello") {
        if (peer.actor || peer.authenticating) throw new BridgeError("SERVICE_HANDSHAKE_INVALID", "Duplicate handshake");
        peer.authenticating = true;
        const authenticated = await authenticateServicePeer(frame, binding, token);
        if (connection.isClosed) return;
        peer.source = authenticated.source_view; peer.actor = authenticated.actor;
        clearTimeout(handshakeTimer);
        await connection.send({ kind: "welcome", protocol: 1, generation, client_id: peer.actor.client_id }); return;
      }
      if (!peer.actor || !("generation" in frame) || frame.generation !== generation) throw new BridgeError("SERVICE_GENERATION_INVALID", "Unauthenticated or stale IPC message");
      if (frame.kind === "cancel_wait") { peer.requests.get(frame.id)?.controller.abort(new BridgeError("OBSERVATION_CANCELLED", "The client request stopped waiting")); return; }
      if (frame.kind !== "request") throw new BridgeError("SERVICE_FRAME_INVALID", "Unexpected client frame");
      // Duplicate IDs cannot be answered as a second request: the original correlation remains owned.
      if (peer.requests.has(frame.id)) throw new BridgeError("SERVICE_REQUEST_LIMIT", "Duplicate connection request identity");
      const operation = frame.operation;
      let args: unknown, lane: RequestLane;
      try {
        if (operation === "coordination") args = decodeCoordinationRequest(frame.arguments);
        else {
          if (!Object.hasOwn(operationSchemas, operation)) throw new BridgeError("SERVICE_OPERATION_UNSUPPORTED", "The requested service operation is not supported");
          const decoded = operationSchemas[operation as Operation].safeParse(frame.arguments);
          if (!decoded.success) throw new BridgeError("SERVICE_ARGUMENT_INVALID", "The operation payload does not satisfy its complete contract");
          args = decoded.data;
        }
        lane = serviceRequestLane(operation, args);
        assertRequestCapacity(peer.requests.values(), lane);
      } catch (error) {
        await connection.send({ kind: "failure", id: frame.id, generation, error: errorValue(error) }); return;
      }
      const controller = new AbortController(); peer.requests.set(frame.id, { controller, lane });
      const work = (async () => {
        try {
          let result: unknown;
          if (operation === "coordination") {
            result = await routeCoordination(runtime, { actor: peer.actor!, source_view: peer.source! }, binding.repositoryId, args, controller.signal);
          } else {
            const selected = operation as Operation;
            const raw = await dispatch(selected, args, peer, controller.signal);
            const decoded = responseSchemas[selected].safeParse(raw);
            if (!decoded.success) throw new BridgeError("SERVICE_RESULT_INVALID", "The operation did not produce its declared destination representation");
            result = decoded.data;
          }
          if (!connection.isClosed) await connection.send({ kind: "response", id: frame.id, generation, result });
        } catch (error) { if (!connection.isClosed) await connection.send({ kind: "failure", id: frame.id, generation, error: errorValue(error) }); }
        finally { peer.requests.delete(frame.id); }
      })();
      await track(work);
    }, () => {
      clearTimeout(handshakeTimer); peers.delete(peer); epoch++;
      for (const request of peer.requests.values()) request.controller.abort(new BridgeError("CLIENT_DETACHED", "Client detached; accepted execution remains service-owned"));
      if (peer.actor) void track(runtime.detachClient(peer.actor.client_id)).catch((error) => console.error(errorValue(error).code));
      maybeExit();
    });
    peer.connection = connection; peers.add(peer);
  });
  server.on("error", fail);
  const releaseReservation = () => { reservation = false; epoch++; maybeExit(); };
  bootstrapInput.once("end", releaseReservation); bootstrapInput.once("close", releaseReservation); bootstrapInput.resume();
  const interrupt = () => beginStop();
  process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
  runtime.onSettled = maybeExit;
  try {
    // Election proves no other new service owns this endpoint. Refuse an unexpected regular/symlink file.
    try { const old = await lstat(paths.endpoint); if (!old.isSocket() || old.uid !== process.getuid?.()) throw new BridgeError("SERVICE_PATH_UNSAFE", "Existing endpoint is not an owned socket"); await unlink(paths.endpoint); }
    catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, () => { server.removeListener("error", reject); resolve(); }); });
    await chmod(paths.endpoint, 0o600);
    const info = await lstat(paths.endpoint); socketIdentity = { dev: info.dev, ino: info.ino };
    const descriptor = DescriptorSchema.parse({ protocol: 1, generation, repository_id: binding.repositoryId, state_root: binding.stateRoot,
      ...(binding.profilePath ? { profile_path: binding.profilePath } : {}), endpoint: paths.endpoint, runtime: identity, process: await processIdentity(), token });
    await atomicJson(paths.descriptor, descriptor, () => {});
    published = true;
    if (draining) beginStop();
    if ((bootstrapInput as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) releaseReservation();
    maybeExit(); await ended;
  } finally {
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
    bootstrapInput.removeListener("end", releaseReservation); bootstrapInput.removeListener("close", releaseReservation);
    for (const peer of peers) peer.connection.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...pending]);
    await runtime.shutdown();
  }
}
