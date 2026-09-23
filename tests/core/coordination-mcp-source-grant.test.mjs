import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCoordinationTools } from '../../.passeur-core/src/mcp/coordination.js';
import { authenticatedFixture, command, key } from '../fixtures/structural/authenticated-peer.mjs';

function body(value) {
  assert.equal(value.isError, false);
  assert.equal(value.content.length, 1);
  assert.equal(value.content[0].type, 'text');
  return JSON.parse(value.content[0].text);
}

test('real MCP client publishes exact source scope and revokes it through elected coordination', async t => {
  const f = await authenticatedFixture(t), endpoint = await f.client();
  await f.initialize(endpoint);
  const server = new McpServer({ name: 'source-grant-public-test', version: '1' });
  const lifetime = new AbortController();
  registerCoordinationTools(server, endpoint, lifetime.signal);
  const client = new Client({ name: 'source-grant-client', version: '1' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const registered = body(await client.callTool({ name: 'passeur_work', arguments: { request: f.register() } }));
    const id = registered.receipt.item_id, recipient = 'b'.repeat(64);
    const grant = command({ kind: 'grant_source', operation_key: key(), work_id: id,
      expected_revision: 1, recipients: [{ recipient, scope: 'report' }] });
    const first = body(await client.callTool({ name: 'passeur_work', arguments: { request: grant } }));
    assert.equal(first.receipt.action, 'grant_source');
    assert.deepEqual(body(await client.callTool({ name: 'passeur_work', arguments: { request: grant } })), first);
    assert.deepEqual((await f.get(endpoint, 'work', id)).source_grants,
      [{ recipient, scope: 'report', work_revision: 2 }]);
    const watch = command({ kind: 'watch_source', operation_key: key(), work_id: id, expected_revision: 2,
      watchers: [{ recipient, regions: [{ kind: 'file', path: 'src/view.js' }],
        dialect_overrides: [{ path: 'src/view.js', dialect: 'jsx' }] }] });
    assert.equal(body(await client.callTool({ name: 'passeur_work', arguments: { request: watch } })).receipt.action, 'watch_source');
    assert.deepEqual((await f.get(endpoint, 'work', id)).source_watches,
      [{ recipient, regions: [{ kind: 'file', path: 'src/view.js' }],
        dialect_overrides: [{ path: 'src/view.js', dialect: 'jsx' }], work_revision: 3 }]);
    const before = f.countsWire().received;
    const malformed = command({ kind: 'grant_source', operation_key: key(), work_id: id,
      expected_revision: 3, recipients: [{ recipient, scope: 'detail' }, { recipient, scope: 'report' }] });
    assert.equal((await client.callTool({ name: 'passeur_work', arguments: { request: malformed } })).isError, true);
    assert.equal(f.countsWire().received, before);
    const revoked = command({ kind: 'grant_source', operation_key: key(), work_id: id, expected_revision: 3, recipients: [] });
    assert.equal(body(await client.callTool({ name: 'passeur_work', arguments: { request: revoked } })).receipt.action, 'grant_source');
    assert.deepEqual((await f.get(endpoint, 'work', id)).source_grants, []);
    assert.deepEqual((await f.get(endpoint, 'work', id)).source_watches, []);
  } finally {
    lifetime.abort();
    await client.close();
    await server.close();
  }
});
