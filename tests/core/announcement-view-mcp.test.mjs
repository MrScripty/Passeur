// Actual SDK registration, canonical service decoding, TaskStore and Git. The frontend dispatch
// is in-process and does not claim authenticated socket, installed-host or native-agent evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../.passeur-core/src/mcp/server.js';
import { operationSchemas, responseSchemas } from '../../.passeur-core/src/contracts/service.js';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { serviceFixture, request, key } from '../fixtures/structural/service-fixture.mjs';

const identity = () => ({ package_version:'fixture', build_id:'fixture', mode:'development', node_version:process.version,
  node_executable:process.execPath, pid:process.pid, started_at:new Date().toISOString() });
const parsed = reply => { assert.equal(reply.isError, false, JSON.stringify(reply)); return JSON.parse(reply.content[0].text); };

test('large announcement returns a small receipt, retries once and retrieves exact pages through the real MCP SDK', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'unused-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const parent = { owner_id:createHash('sha256').update(token).digest('hex'), client_id:randomUUID() };
  const runtime = new RepositoryRuntime(intent, identity(), {}, { PASSEUR_OBSERVATION_MONITOR:'off' });
  f.sessions.push({close:() => runtime.shutdown()});
  await runtime.coordinate(request('initialize', {limits:f.limits}), parent, f.root);
  let actor = parent, calls = 0;
  const frontend = { identity:identity(), async shutdown() {},
    async call(operation, raw, signal) {
      calls++; const args = operationSchemas[operation].parse(raw);
      const value = operation === 'announce' ? await runtime.announce(args, actor, f.root, signal)
        : operation === 'announcement' ? await runtime.announcement(args.id, actor, f.root, signal)
        : assert.fail(`unexpected operation ${operation}`);
      return responseSchemas[operation].parse(value);
    } };
  const owner = createMcpServer(frontend), client = new Client({name:'announcement-pages-test', version:'1'}, {capabilities:{}});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([owner.mcp.connect(st), client.connect(ct)]);
    const assignment = {schema_version:3, request_key:key(), agent_id:'fixture', mode:'implement',
      objective:'Retain the full assignment without echoing it', context:'PRIVATE_SENTINEL'.repeat(1900),
      acceptance_criteria:['Return the exact announcement reference'], allowed_paths:['source.ts'],
      base_commit:f.base, target_ref:'refs/heads/main'};
    const args = {schema_version:1, operation_key:key(), assignment, readers:[]};
    const firstWire = await client.callTool({name:'passeur_announce', arguments:args}), first = parsed(firstWire);
    assert.equal(first.schema_version, 2); assert.ok(Buffer.byteLength(JSON.stringify(firstWire)) < 24576);
    assert.equal(JSON.stringify(first).includes('PRIVATE_SENTINEL'), false);
    const second = parsed(await client.callTool({name:'passeur_announce', arguments:args}));
    assert.deepEqual(second, first);
    const state = JSON.parse(await readFile(join(binding.storeRoot,'coordination/control.json'), 'utf8'));
    assert.equal(state.announcements.filter(a=>a.id===first.record.id).length, 1);
    const summary = parsed(await client.callTool({name:'passeur_announcement', arguments:{schema_version:1,id:first.record.id}}));
    assert.deepEqual(summary, first);
    const chunks = []; let offset = 0;
    do {
      const wire = await client.callTool({name:'passeur_announcement', arguments:{schema_version:1,id:first.record.id,
        view:'assignment', offset, limit:4096, expected_sha256:first.payload.sha256}});
      const page = parsed(wire); assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 24576);
      chunks.push(page.content); offset = page.next_offset; if(page.eof) break;
    } while(true);
    assert.deepEqual(JSON.parse(chunks.join('')), assignment);
    const before = calls;
    const invalid = await client.callTool({name:'passeur_announcement', arguments:{schema_version:1,id:first.record.id,view:'assignment',offset:1}});
    assert.equal(invalid.isError, true); assert.equal(calls, before);
    // A page has no reusable access capability. Changing the caller checks current source-owner policy again.
    actor = {owner_id:'f'.repeat(64), client_id:randomUUID()};
    const denied = await client.callTool({name:'passeur_announcement', arguments:{schema_version:1,id:first.record.id,
      view:'assignment', offset:0, expected_sha256:first.payload.sha256}});
    assert.equal(denied.isError, true);
    assert.equal(JSON.stringify(denied).includes('PRIVATE_SENTINEL'), false);
  } finally { await client.close(); await owner.shutdown(); await owner.mcp.close(); }
});
