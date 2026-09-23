import { createServer } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { chmod } from 'node:fs/promises';
import { runtimeFixture, request, command, readRequest, key, hold, git, BridgeError } from './runtime-fixture.mjs';
import { ServiceClient } from '../../../.passeur-core/src/service/client.js';
import { IpcConnection } from '../../../.passeur-core/src/service/transport.js';
import { authenticateServicePeer } from '../../../.passeur-core/src/service/peer-auth.js';
import { routeCoordination } from '../../../.passeur-core/src/service/coordination-route.js';
import { decodeCoordinationRequest } from '../../../.passeur-core/src/contracts/coordination-service.js';
import { serviceRequestLane, assertRequestCapacity } from '../../../.passeur-core/src/service/request-capacity.js';
export { request, command, readRequest, key, hold, git, BridgeError, ServiceClient, authenticateServicePeer };

// Fixture listener; production authentication, route, client, framing and runtime are the subjects.
// Election, descriptor discovery, and task inventory/recovery retain the runtime fixture's exclusions.
export async function authenticatedFixture(t, options = {}) {
  const f = await runtimeFixture(t), operator = await f.token();
  const token = randomBytes(32).toString('hex'), generation = randomUUID(), endpoint = join(f.temp, 'auth.sock');
  const peers = new Set(), clients = new Set(), pending = new Set(), gates = [], failures = [];
  let beforeRoute, transform, dropReply, onResponse, received = 0, accepted = 0;
  const server = createServer(socket => {
    const slots = new Map(); let identity, authenticating = false;
    const connection = new IpcConnection(socket, async frame => {
      if (frame.kind === 'hello') {
        if (identity || authenticating) throw new BridgeError('SERVICE_HANDSHAKE_INVALID', 'Duplicate handshake');
        authenticating = true;
        identity = await authenticateServicePeer(frame, f.binding, token);
        if (!connection.isClosed) await connection.send({ kind: 'welcome', protocol: 1, generation, client_id: identity.actor.client_id });
        return;
      }
      if (!identity || frame.generation !== generation) throw new BridgeError('SERVICE_GENERATION_INVALID', 'Stale or unauthenticated frame');
      if (frame.kind === 'cancel_wait') { slots.get(frame.id)?.controller.abort(new BridgeError('OBSERVATION_CANCELLED', 'Observer detached')); return; }
      if (frame.kind !== 'request' || slots.has(frame.id)) throw new BridgeError('SERVICE_FRAME_INVALID', 'Unexpected or duplicate frame');
      received++;
      let req, lane;
      try {
        if (frame.operation !== 'coordination') throw new BridgeError('SERVICE_OPERATION_UNSUPPORTED', 'Fixture exercises only the production metadata route');
        req = decodeCoordinationRequest(frame.arguments); lane = serviceRequestLane(frame.operation, req);
        assertRequestCapacity(slots.values(), lane);
      } catch (e) {
        await connection.send({ kind: 'failure', id: frame.id, generation, error: { code: e.code, message: e.message } }); return;
      }
      const controller = new AbortController(); slots.set(frame.id, { lane, controller }); accepted++;
      const work = (async () => {
        try {
          if (beforeRoute) await beforeRoute(req);
          let result = await routeCoordination(f.runtime, identity, f.binding.repositoryId, req, controller.signal);
          if (transform) result = transform(req, result);
          if (dropReply?.(req, result)) { connection.close(); return; }
          if (!connection.isClosed) await connection.send({ kind: 'response', id: frame.id, generation, result });
          onResponse?.(req);
        } catch (e) {
          if (!connection.isClosed) await connection.send({ kind: 'failure', id: frame.id, generation, error: { code: e.code ?? 'TEST_ERROR', message: e.message } });
        } finally { slots.delete(frame.id); }
      })();
      pending.add(work); try { await work; } finally { pending.delete(work); }
    }, () => {
      peers.delete(connection); if (connection.error) failures.push(connection.error.code);
      for (const v of slots.values()) v.controller.abort(new BridgeError('CLIENT_DETACHED', 'Observer disconnected'));
    });
    peers.add(connection);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  await chmod(endpoint, 0o600);
  f.sessions.push({ async close() {
    for (const gate of gates) gate.release();
    for (const c of clients) c.close();
    for (const c of peers) c.close();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending]);
    await Promise.all([...clients].map(c => c.connection.closed));
  } });
  const descriptor = { protocol: 1, generation, repository_id: f.binding.repositoryId, state_root: f.binding.stateRoot,
    profile_path: f.binding.profilePath, endpoint, token, runtime: { package_version: 'fixture', build_id: 'fixture', mode: 'development' },
    process: { pid: process.pid, boot_id: 'fixture', started: '1' } };
  const client = async (ownerToken = operator, source = f.root, overrides = {}) => {
    const c = new ServiceClient({ ...descriptor, ...overrides }, { ...f.binding, project: source }, ownerToken); clients.add(c);
    await c.ready; return c;
  };
  const initialize = async c => c.coordinate(request('initialize', { limits: f.limits }));
  const get = async (c, kind, id) => {
    const selector = kind === 'receipt' ? { kind, operation_key: id } : { kind, id };
    let offset = 0, expected_hash = null, text = '';
    while (true) {
      const p = await c.coordinate(readRequest(selector, { offset, expected_hash, limit: 257 }));
      text += p.content; offset = p.next_offset; expected_hash = p.hash;
      if (p.eof) return JSON.parse(text);
    }
  };
  return { ...f, operatorToken: operator, descriptor, client, initialize, get, failures,
    owner: t => createHash('sha256').update(t).digest('hex'),
    gate() { const gate = f.gate(); gates.push(gate); return gate; },
    setBeforeRoute(fn) { beforeRoute = fn; }, setTransform(fn) { transform = fn; }, setDropReply(fn) { dropReply = fn; },
    setOnResponse(fn) { onResponse = fn; }, countsWire() { return { received, accepted, pending: pending.size }; },
  };
}
