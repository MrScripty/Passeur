#!/usr/bin/env node
// Scripted app-server peer used only by adapter contract tests. It performs no inference or shell task.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CODEX_HOME;
const scenario = readFileSync(join(home, 'fixture-scenario'), 'utf8');
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let workspace, turn = 'turn-fixture', turnCount = 0;
const item = value => { send({method:'item/started',params:{threadId:'thread-fixture',turnId:turn,item:{id:value.id,type:value.type}}});send({method:'item/completed',params:{threadId:'thread-fixture',turnId:turn,item:value}}); };
const complete = (decision) => {
  if (decision) writeFileSync(join(home, 'fixture-decision'), decision);
  const report = { schema_version:2, kind:'final', summary: decision === 'decline' ? 'Permission declined' : 'Scoped fixture complete',
    assessment: decision === 'decline' ? 'unmet' : 'met', blockers: [], questions: [], checks: [] };
  const text = scenario === 'bad-report' && turnCount === 1 ? 'no structured report' : scenario === 'question' && turnCount === 1 ? 'PASSEUR_MESSAGE {"schema_version":2,"kind":"input_required","question":"Which format?"}' : `PASSEUR_MESSAGE ${JSON.stringify(report)}`;
  if(scenario==='pending-item')send({method:'item/started',params:{threadId:'thread-fixture',turnId:turn,item:{id:'background',type:'commandExecution'}}});
  item({id:`report-${turnCount}`,type:'agentMessage',text});
  send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: turn,
    status: scenario === 'native-failure' ? 'failed' : 'completed', error: scenario === 'native-failure' ? { message: 'failure fixture' } : null } } });
  if(scenario==='pending-item')setTimeout(()=>{
    writeFileSync(join(home,'background-settled'),'yes');send({method:'item/completed',params:{threadId:'thread-fixture',turnId:turn,item:{id:'background',type:'commandExecution',command:'fixture',cwd:workspace,status:'completed',exitCode:0}}});
  },30);
};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 'approval-fixture' && !message.method) {
    if (message.result) complete(message.result.decision);
    return;
  }
  if (message.id === undefined) return;
  const reply = result => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize': reply({ userAgent: 'controlled-fixture/1' }); break;
    case 'account/read': reply({ requiresOpenaiAuth: true, account: scenario === 'api-key' ? { type: 'apiKey' } : { type: 'chatgpt' } }); break;
    case 'config/read': reply({ config: { forced_login_method: 'chatgpt', mcp_servers: scenario === 'recursive' ? { forbidden: {} } : {},
      features: { multi_agent: false, apps: false, plugins: false }, web_search: 'disabled' } }); break;
    case 'thread/start': {
      if (message.params.sandbox !== 'workspace-write' || message.params.approvalPolicy !== 'on-request') throw new Error('Wrong native outgoing contract');
      workspace = message.params.cwd;
      reply({ thread: { id: 'thread-fixture' }, model: scenario === 'wrong-model' ? 'other-model' : message.params.model,
        modelProvider: 'openai', cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] } }); break;
    }
    case 'mcpServerStatus/list': reply({ data: [], nextCursor: null }); break;
    case 'turn/start': {
      turnCount++; turn=`turn-${turnCount}`; writeFileSync(join(home,'fixture-turns'),String(turnCount));
      if(message.params.threadId!=='thread-fixture')throw Error('Continuation must keep the same thread');
      if (scenario === 'approval' || scenario === 'amendment') {
        send({ id: 'approval-fixture', method: 'item/commandExecution/requestApproval', params: {
          threadId: 'thread-fixture', turnId: turn, itemId: 'command-fixture', cwd: workspace, command: 'fixture-operation',
          ...(scenario === 'amendment' ? { proposedExecpolicyAmendment: ['fixture-operation'] } : {}),
        } });
      } else if (scenario === 'cancel') {
        item({id:'waiting-fixture',type:'agentMessage',text:'Waiting for owner cancellation'});
      } else complete(); // Deliberately send events before the correlated turn/start response.
      reply({ turn: { id: turn, status: 'inProgress' } }); break;
    }
    case 'turn/interrupt': reply({}); break;
    default: send({ id: message.id, error: { code: -32601, message: 'Unknown fixture operation' } });
  }
});
lines.on('close', () => process.exit(0));
