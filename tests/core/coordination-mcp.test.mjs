// Required pinned SDK/Zod evidence. No replacement framework or conditional skip is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCoordinationTools, CoordinationInfoInputSchema, CoordinationWorkInputSchema, CoordinationNotesInputSchema, CoordinationReconciliationInputSchema } from '../../.passeur-core/src/mcp/coordination.js';
import { COORDINATION_TOOL_NAMES } from '../../.passeur-core/src/mcp/coordination-operations.js';
import { createMcpServer } from '../../.passeur-core/src/mcp/server.js';
import { PasseurFrontend } from '../../.passeur-core/src/service/client.js';
import { CODEX_ENABLED_TOOLS } from '../../.passeur-core/src/codex/config.js';
import { publicRequests, initialization } from '../fixtures/structural/public-requests.mjs';
import { authenticatedFixture, readRequest, command, key } from '../fixtures/structural/authenticated-peer.mjs';
const schemas={passeur_coordination:CoordinationInfoInputSchema,passeur_work:CoordinationWorkInputSchema,passeur_notes:CoordinationNotesInputSchema,passeur_reconciliation:CoordinationReconciliationInputSchema};

async function connect(server) {
 const client=new Client({name:'passeur-metadata-test',version:'1'},{capabilities:{}});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 try{await Promise.all([server.connect(st),client.connect(ct)]);return client}
 catch(error){await client.close();await server.close();throw error}
}
function result(value){assert.equal(value.isError,false);assert.equal(value.content.length,1);assert.equal(value.content[0].type,'text');return JSON.parse(value.content[0].text)}

test('generated metadata input shapes accept the independently authored valid contract cases',()=>{
 for(const [tool,request] of publicRequests)assert.deepEqual(schemas[tool].parse({request}),{request});
 for(const [tool,schema] of Object.entries(schemas)){
  assert.equal(schema.safeParse({request:initialization}).success,false);
  for(const [other,request] of publicRequests)if(other!==tool)assert.equal(schema.safeParse({request}).success,false);
 }
});
test('projected runtime validation preserves canonical byte, uniqueness and cross-field rules',()=>{
 const reg=publicRequests.find(([_,r])=>r.command?.kind==='register_external_work')[1];
 for(const patch of [{input_oid:'main'},{readers:['b'.repeat(64),'b'.repeat(64)]},{intent:'界'.repeat(2000)},{approved:true}])assert.equal(CoordinationWorkInputSchema.safeParse({request:{...reg,command:{...reg.command,...patch}}}).success,false);
 const note=publicRequests.find(([_,r])=>r.command?.note_kind==='agreement_proposal')[1];
 assert.equal(CoordinationNotesInputSchema.safeParse({request:{...note,command:{...note.command,parties:[]}}}).success,false);
 const read=publicRequests.find(([_,r])=>r.kind==='read')[1];
 assert.equal(CoordinationInfoInputSchema.safeParse({request:{...read,offset:1,expected_hash:null}}).success,false);
});
test('actual full MCP catalog and registration projection agree without service preparation',async()=>{
 const frontend=new PasseurFrontend({project:'/nonexistent-passeur-catalog-test'}, {package_version:'fixture',build_id:'fixture',mode:'development',node_version:process.version,node_executable:process.execPath,pid:process.pid,started_at:new Date().toISOString()},'/unused-cli');
 const owner=createMcpServer(frontend);let client;
 try{
  client=await connect(owner.mcp);const tools=(await client.listTools()).tools;
  assert.deepEqual(tools.map(t=>t.name).sort(),[...CODEX_ENABLED_TOOLS].sort());
  for(const name of COORDINATION_TOOL_NAMES){const tool=tools.find(t=>t.name===name);assert.equal(tool.inputSchema.type,'object');assert.ok(tool.inputSchema.properties.request);assert.equal(tool.inputSchema.additionalProperties,false)}
  assert.equal(frontend.status().service.state,'not_checked');
  for(const name of COORDINATION_TOOL_NAMES){const reply=await client.callTool({name,arguments:{request:initialization}});assert.equal(reply.isError,true)}
  assert.equal(frontend.status().service.state,'not_checked');
 }finally{await client?.close();await owner.shutdown();await owner.mcp.close()}
});
test('SDK tool calls use the authenticated metadata path and return a recoverable exact receipt',async t=>{
 const f=await authenticatedFixture(t), endpoint=await f.client();await f.initialize(endpoint);
 const server=new McpServer({name:'metadata-consumer-test',version:'1'}),lifetime=new AbortController();
 registerCoordinationTools(server,endpoint,lifetime.signal);const client=await connect(server);
 try{
  const req=f.register(), a=result(await client.callTool({name:'passeur_work',arguments:{request:req}}));
  const b=result(await client.callTool({name:'passeur_work',arguments:{request:req}}));assert.deepEqual(a,b);
  const workId=a.receipt.item_id;
  const page=result(await client.callTool({name:'passeur_coordination',arguments:{request:readRequest({kind:'work',id:workId})}}));assert.equal(page.kind,'page');
  const note=command({kind:'post_note',operation_key:key(),subject:{kind:'work',id:workId},note_kind:'statement',text:'This is attributed data, not a command.',parties:[]});
  assert.equal(result(await client.callTool({name:'passeur_notes',arguments:{request:note}})).kind,'receipt');
  const before=f.countsWire().received;
  assert.equal((await client.callTool({name:'passeur_work',arguments:{request:note}})).isError,true);assert.equal(f.countsWire().received,before);
  assert.equal(f.counts.profile,0);
 }finally{lifetime.abort();await client.close();await server.close()}
});
