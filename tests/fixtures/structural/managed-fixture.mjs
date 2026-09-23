import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runtimeFixture, command, key, git } from './runtime-fixture.mjs';
import { initialControl } from '../../../.passeur-core/src/core/task-control.js';
export { command, key, git };

/** Real runtime/control/Git/disposition, with explicit task-record/lease/recovery seams. */
export async function managedFixture(t, options={}) {
  const f=await runtimeFixture(t,options);
  const admissions=new Map(), states=new Map(), results=new Map(), operations=new Map(), writes=[];
  let beforeControlRead, beforeOperationWrite, beforeResourceWrite;
  Object.assign(f.taskStore,{
    async durableRequest(id) {
      const record=admissions.get(id); assert.ok(record,'fixture task must have an explicitly admitted immutable request'); return structuredClone(record);
    },
    async find(query) { return structuredClone(query.task_id ? admissions.get(query.task_id) : [...admissions.values()].find(r=>r.request.request_key===query.request_key)); },
    async readControl(id) { if(beforeControlRead) await beforeControlRead(id); const state=states.get(id); assert.ok(state,'fixture control must be explicitly declared'); return structuredClone(state); },
    async writeControl(id,state) { assert.ok(states.has(id)); states.set(id,structuredClone(state)); f.phases.set(id,state.phase); },
    async readResult(id) { return structuredClone(results.get(id)); },
    async readOperation(id,key) { return structuredClone(operations.get(`${id}:${key}`)); },
    async writeOperation(id,value) { if(beforeOperationWrite) await beforeOperationWrite(id,value); writes.push({kind:'operation',id}); operations.set(`${id}:${value.operation.operation_key}`,structuredClone(value)); },
    async writeResource(id,value) { if(beforeResourceWrite) await beforeResourceWrite(id,value); writes.push({kind:'resource',id,state:value.state}); f.claims.set(id,structuredClone(value)); },
  });
  const addTask=async ({owner=f.ordinary.owner_id, phase='terminal', objective='Preserve cancellation stop evidence', allowed_paths=['source.ts'], format}={})=>{
    assert.equal(format,undefined,'repository object format belongs to fixture construction');
    const name='task-'+key(), path=await f.linked(name), id=randomUUID();
    const head=await f.commit(path,'source.ts','export function run(reason?: string) { return reason; }\n');
    const state=initialControl(id,owner); state.phase=phase;
    if(phase==='terminal') { state.outcome='completed'; state.native.state='stopped'; }
    states.set(id,state);f.phases.set(id,phase);
    const admission={schema_version:4,task_id:id,project_id:f.binding.repositoryId,source_view:f.root,initial_owner:owner,
      request:{schema_version:3,request_key:'managed-'+id,agent_id:'fixture',mode:'implement',objective,base_commit:f.base,target_ref:'refs/heads/main',allowed_paths},
    };
    admissions.set(id,admission);
    f.claims.set(id,{schema_version:1,task_id:id,project_id:f.binding.repositoryId,state:'pending',worktree_path:path,branch_ref:`refs/heads/${name}`,base_commit:f.base,head_commit:head});
    results.set(id,{worker_stop:'confirmed'});
    return {id,path,head,branch:`refs/heads/${name}`,admission};
  };
  const enrollRequest=(id,operation_key=key())=>command({kind:'register_managed_work',operation_key,task_id:id});
  const enroll=async(task,actor=f.ordinary,operation_key=key())=>f.call(enrollRequest(task.id,operation_key),actor);
  const claimCase=async(actor=f.ordinary,members=[])=>{
    const response=await f.call(command({kind:'claim_target',operation_key:key(),target:'refs/heads/main',members}),actor);
    return f.get('case',response.receipt.item_id,actor);
  };
  const caseRequest=(kind,item,extra={})=>command({kind,operation_key:key(),case_id:item.id,expected_revision:item.revision,generation:item.generation,...extra});
  const select=async(task,item,actor=f.ordinary)=>{
    await f.call(caseRequest('select_inputs',item,{target_oid:f.base,inputs:[{work_id:task.id,commit_oid:task.head}]}),actor);
    return f.get('case',item.id,actor);
  };
  const archive=task=>({task_id:task.id,operation_key:key(),disposition:'archived',expected_head:task.head,expected_branch_ref:task.branch,cleanup_authorized:true,archive_authorized:true,reason:'test-owned task result protection'});
  return {...f, get runtime(){return f.runtime;}, get operator(){return f.operator;}, admissions,states,results,operations,writes,addTask,enrollRequest,enroll,claimCase,caseRequest,select,archive,
    setBeforeControlRead(fn){beforeControlRead=fn;},setBeforeOperationWrite(fn){beforeOperationWrite=fn;},setBeforeResourceWrite(fn){beforeResourceWrite=fn;}};
}
