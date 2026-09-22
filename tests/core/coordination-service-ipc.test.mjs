import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { writeFile, access, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { IpcConnection } from '../../.passeur-core/src/service/transport.js';
import { decodeCoordinationReply } from '../../.passeur-core/src/contracts/coordination-service.js';
import { serviceFixture, A, B, request, command, readRequest, caseCommand, key } from '../fixtures/structural/service-fixture.mjs';

async function peerFixture(t, dropKeys = []) {
  const f = await serviceFixture(t); await f.service.close();
  const linked = await f.linked('peer-work');
  const config = { state: f.state, repository: f.repositoryId, operator: A.owner_id, roots: [f.root, linked],
    limits: f.serviceLimits, socket: join(f.temp, 'peer.sock'), token: randomBytes(32).toString('hex'), drop_keys: dropKeys,
    parents: [ { owner: A.owner_id, source: f.root, token: randomBytes(32).toString('hex') },
      { owner: B.owner_id, source: linked, token: randomBytes(32).toString('hex') } ] };
  const configPath = join(f.temp, 'peer.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  let processPeer, exit, shutdown, errorText = '', connections = [];
  const start = async () => {
    processPeer = fork(fileURLToPath(new URL('../fixtures/structural/service-peer.mjs', import.meta.url)), [configPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    processPeer.stderr.on('data', data => { errorText += data; });
    exit = once(processPeer, 'exit'); exit.catch(() => {});
    const ready = once(processPeer, 'message');
    const observed = await Promise.race([ready.then(([message]) => message), exit.then(([code]) => { throw new Error(`Fixture exited before ready: ${code}: ${errorText}`); })]);
    assert.equal(observed.kind, 'ready'); shutdown = undefined;
  };
  const stop = () => shutdown ??= (async () => {
    for (const client of connections) client.close();
    if (processPeer.connected) processPeer.send({ kind: 'stop' });
    const [code, signal] = await exit;
    assert.equal(code, 0, errorText); assert.equal(signal, null); assert.equal(errorText, '');
    await assert.rejects(access(config.socket), { code: 'ENOENT' });
  })();
  f.sessions.push({ close: stop });
  await start();
  const client = async (actor = A) => {
    const selected = config.parents.find(p => p.owner === actor.owner_id), socket = createConnection(config.socket);
    let generation, resolveReady, rejectReady;
    const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; }); ready.catch(() => {});
    const pending = new Map();
    const connection = new IpcConnection(socket, frame => {
      if (frame.kind === 'welcome') { generation = frame.generation; resolveReady(); return; }
      assert.equal(frame.generation, generation); const p = pending.get(frame.id); assert.ok(p, 'correlated response'); pending.delete(frame.id);
      if (frame.kind === 'failure') { p.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code })); return; }
      assert.equal(frame.kind, 'response');
      try { p.resolve(decodeCoordinationReply(p.request, selected.owner, f.repositoryId, frame.result)); } catch (e) { p.reject(e); }
    }, () => {
      const error = Object.assign(new Error('Test observer disconnected'), { code: 'TEST_DISCONNECTED' });
      rejectReady(error); for (const p of pending.values()) p.reject(error); pending.clear();
    });
    socket.once('connect', () => { void connection.send({ kind: 'hello', protocol: 1, token: config.token,
      owner_token: selected.token, repository_id: f.repositoryId, source_view: selected.source, state_root: f.state }).catch(rejectReady); });
    await ready;
    const result = { close: () => connection.close(), async call(req) {
      const id = randomUUID(); let resolve, reject;
      const answer = new Promise((yes, no) => { resolve = yes; reject = no; }); answer.catch(() => {});
      pending.set(id, { request: req, resolve, reject });
      try { await connection.send({ kind: 'request', operation: 'coordination', id, generation, arguments: req }); }
      catch (error) { pending.delete(id); reject(error); }
      return answer;
    }, async get(kind, id) {
      const selector = kind === 'receipt' ? { kind, operation_key: id } : { kind, id };
      let offset = 0, expected_hash = null, text = '';
      while (true) {
        const page = await this.call(readRequest(selector, { offset, expected_hash, limit: 127 }));
        text += page.content; offset = page.next_offset; expected_hash = page.hash;
        if (page.eof) return JSON.parse(text);
      }
    } };
    connections.push(result); return result;
  };
  return { ...f, client, config, async restart() { await stop(); connections = []; await start(); } };
}

test('real framed connections share one metadata owner and retain separate parent authority', async t => {
  const f = await peerFixture(t), a = await f.client(A), b = await f.client(B);
  assert.equal((await b.call(request('identity'))).parent_id, B.owner_id);
  await assert.rejects(b.call(request('initialize', { limits: f.limits })), { code: 'TEST_INIT_FORBIDDEN' });
  await a.call(request('initialize', { limits: f.limits }));
  const [ar, br] = await Promise.all([a.call(f.registerRequest({ intent: '第一 😀', readers: [B.owner_id] })), b.call(f.registerRequest())]);
  assert.notEqual(ar.receipt.item_id, br.receipt.item_id);
  const work = await b.get('work', ar.receipt.item_id); assert.equal(work.intent, '第一 😀');
  await assert.rejects(a.get('work', br.receipt.item_id), { code: 'COORDINATION_NOT_FOUND' });
  const before = await f.disk();
  await assert.rejects(b.call(command({ kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: work.revision })), { code: 'COORDINATION_FORBIDDEN' });
  assert.deepEqual(await f.disk(), before);
});
test('two concurrent framed target claims create exactly one case and one leader', async t => {
  const f = await peerFixture(t), a = await f.client(A), b = await f.client(B);
  await a.call(request('initialize', { limits: f.limits }));
  const claim = () => command({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [] });
  const outcomes = await Promise.allSettled([a.call(claim()), b.call(claim())]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const failure = outcomes.find(r => r.status === 'rejected'); assert.equal(failure.reason.code, 'COORDINATION_TARGET_HELD');
  const state = await f.disk(); assert.equal(state.cases.length, 1); assert.ok([A.owner_id, B.owner_id].includes(state.cases[0].lead));
});
test('publication followed by a dropped framed response recovers by receipt without repeating the command', async t => {
  const operation = key(), f = await peerFixture(t, [operation]), a = await f.client();
  await a.call(request('initialize', { limits: f.limits }));
  await assert.rejects(a.call(f.registerRequest({ operation_key: operation })), { code: 'TEST_DISCONNECTED' });
  const revision = (await f.disk()).revision, reattached = await f.client();
  const receipt = await reattached.get('receipt', operation); assert.equal(receipt.action, 'register_work');
  const work = await reattached.get('work', receipt.item_id); assert.equal(work.owner, A.owner_id);
  assert.equal((await f.disk()).revision, revision); assert.equal((await f.disk()).works.length, 1);
});
test('malformed operation arguments are refused by the real receiver and leave the connection usable', async t => {
  const f = await peerFixture(t), a = await f.client(); await a.call(request('initialize', { limits: f.limits }));
  const before = await f.disk();
  const injected = f.registerRequest(); injected.command.owner_id = B.owner_id;
  await assert.rejects(a.call(injected), { code: 'COORDINATION_INVALID' });
  await assert.rejects(a.call({ schema_version: 1, kind: 'status', actor: A.owner_id }), { code: 'COORDINATION_SERVICE_INVALID' });
  assert.deepEqual(await f.disk(), before); assert.equal((await a.call(request('status'))).state, 'ready');
});
test('a new peer process reopens retained metadata and releases a case after the source disappears', async t => {
  const f = await peerFixture(t), a = await f.client(); await a.call(request('initialize', { limits: f.limits }));
  const claimed = await a.call(command({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [] }));
  const item = await a.get('case', claimed.receipt.item_id);
  a.close(); await f.restart(); await rename(f.root, join(f.temp, 'moved-source'));
  const fresh = await f.client(); assert.equal((await fresh.get('case', item.id)).generation, item.generation);
  await fresh.call(caseCommand('release_case', item));
  assert.equal((await fresh.get('case', item.id)).state, 'closed');
});
