// Controlled process peer, not a substitute for the production election/authentication owner.
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CoordinationService } from '../../../.passeur-core/src/service/coordination.js';
import { IpcConnection } from '../../../.passeur-core/src/service/transport.js';
import { BridgeError } from '../../../.passeur-core/src/core/errors.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const generation = randomUUID(), peers = new Set();
const session = new CoordinationService({ store_root: config.state, repository_id: config.repository }, {
  assertOwned() {}, // Test process is sole writer; real election is outside this fixture's claim.
  async authorizeInitialization(actor) {
    if (actor.owner_id !== config.operator) throw new BridgeError('TEST_INIT_FORBIDDEN', 'Fixture denied initialization');
  },
  externalWorkspaces: { async assertExternalRegistration(_actor, workspace) {
    if (!config.roots.includes(workspace.root)) throw new BridgeError('TEST_WORKSPACE_FORBIDDEN', 'Fixture denied this root');
  } },
}, config.limits);
const server = createServer(socket => {
  let actor;
  const waits = new Map();
  const peer = new IpcConnection(socket, async frame => {
    if (frame.kind === 'hello') {
      const named = config.parents.find(p => p.token === frame.owner_token);
      if (actor || frame.token !== config.token || !named || frame.source_view !== named.source || frame.repository_id !== config.repository) throw new BridgeError('TEST_HELLO_INVALID', 'Fixture identity did not match');
      actor = { owner_id: named.owner, source_view: named.source };
      await peer.send({ kind: 'welcome', protocol: 1, generation, client_id: randomUUID() }); return;
    }
    if (!actor || frame.generation !== generation) throw new BridgeError('TEST_GENERATION_INVALID', 'Fixture has no matching authenticated context');
    if (frame.kind === 'cancel_wait') { waits.get(frame.id)?.abort(new Error('Fixture request detached')); return; }
    if (frame.kind !== 'request' || frame.operation !== 'coordination' || waits.has(frame.id)) throw new BridgeError('TEST_REQUEST_INVALID', 'Fixture expected one correlated request');
    const wait = new AbortController(); waits.set(frame.id, wait);
    try {
      const result = await session.handle(actor, frame.arguments, wait.signal);
      // Fault is after durable session completion: do not substitute a pre-publication disconnect.
      if (frame.arguments.kind === 'command' && config.drop_keys.includes(frame.arguments.command.operation_key)) { peer.close(); return; }
      if (!peer.isClosed) await peer.send({ kind: 'response', id: frame.id, generation, result });
    } catch (error) {
      if (!peer.isClosed) await peer.send({ kind: 'failure', id: frame.id, generation, error: { code: error instanceof BridgeError ? error.code : 'TEST_ERROR', message: error.message.slice(0, 2048) || 'fixture failure' } });
    } finally { waits.delete(frame.id); }
  }, () => { for (const wait of waits.values()) wait.abort(new Error('Fixture connection closed')); });
  peers.add(peer);
});
let stopping;
function stop() {
  return stopping ??= (async () => {
    session.beginDrain();
    for (const peer of peers) peer.close();
    await new Promise(resolve => server.close(resolve));
    for (const peer of peers) await peer.drain();
    await session.close();
    await assert.rejects(access(config.socket), { code: 'ENOENT' });
    process.disconnect?.();
  })();
}
process.on('message', message => { if (message?.kind === 'stop') void stop().catch(error => { console.error(error.message); process.exitCode = 1; process.disconnect?.(); }); });
process.once('disconnect', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
process.send({ kind: 'ready', generation });
