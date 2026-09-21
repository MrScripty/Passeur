import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "../fixtures/bridge.js";
import { TaskStore } from "../../src/store/task-store.js";
import { TaskControls } from "../../src/core/task-control.js";
import { InputBroker } from "../../src/core/input-broker.js";
import { reconcileStoredTasks } from "../../src/core/recovery.js";
import { baseResult } from "../../src/core/result.js";

it("publishes admission/control together and reopens the unchanged source-view identity", async()=>{
  const f=await fixture();
  try {
    const record=f.admission(f.request("publication"));await f.store.create(record,f.initial(record.task_id));
    const raw=await readFile(join(f.store.taskDir(record.task_id),"request.json"));
    const reopened=new TaskStore(f.state);
    expect(await reopened.durableRequest(record.task_id)).toEqual(record);
    expect((await reopened.readControl(record.task_id)).owner_id).toBe(f.owner.owner_id);
    await reconcileStoredTasks(reopened);
    expect((await reopened.readControl(record.task_id)).phase).toBe("needs_attention");
    expect(await reopened.readResult(record.task_id)).toBeUndefined();
    expect(await readFile(join(f.store.taskDir(record.task_id),"request.json"))).toEqual(raw);
  } finally {await f.dispose();}
});
it("answered input without a native acknowledgment remains unknown after restart",async()=>{
  const f=await fixture(),abort=new AbortController();
  try {
    const record=f.admission(f.request("unknown-answer"));await f.store.create(record,f.initial(record.task_id));
    const controls=new TaskControls(f.store,8,32),broker=new InputBroker(controls,4);
    await controls.change(record.task_id,s=>{s.phase="active";s.native.state="observed_live";s.native.turn_id="turn";});
    const pending=broker.request(record.task_id,{kind:"clarification",question:"Which format?",attention:false},"native",abort.signal);
    pending.catch(()=>undefined);
    let observed=await controls.read(record.task_id,f.owner);
    while(!observed.inputs.length){await new Promise<void>(r=>setImmediate(r));observed=await controls.read(record.task_id,f.owner);}
    const id=observed.inputs[0]!.input_id,claimed=await broker.claim(record.task_id,id,f.owner,1);
    await broker.answer(record.task_id,id,f.owner,1,claimed.claim!.id,"answer-once","JSON");expect(await pending).toBe("JSON");
    await reconcileStoredTasks(new TaskStore(f.state));
    const after=await f.store.readControl(record.task_id);
    expect(after.inputs[0]!.state).toBe("delivery_unknown");expect(after.phase).toBe("needs_attention");
    expect(await f.store.frozenReason()).toBeDefined();expect(await f.store.readResult(record.task_id)).toBeUndefined();
  } finally {abort.abort();await f.dispose();}
});
it("corrupt control generation cannot authorize native dispatch",async()=>{
  const f=await fixture();
  try{
    const record=f.admission(f.request("control-proof"));await f.store.create(record,f.initial(record.task_id));
    const file=join(f.store.taskDir(record.task_id),"state.json"),state=JSON.parse(await readFile(file,"utf8"));
    state.owner_id="not-a-capability-hash";await writeFile(file,JSON.stringify(state));
    await expect(new TaskStore(f.state).readControl(record.task_id)).rejects.toMatchObject({code:"STORE_CORRUPT"});
  }finally{await f.dispose();}
});
it("recovery preserves a failed terminal result without rewriting its immutable bytes",async()=>{
  const f=await fixture();
  try{
    const record=f.admission(f.request("answer-proof"));const control=f.initial(record.task_id);await f.store.create(record,control);
    const result=baseResult(record.task_id,record.request,record.execution);result.worker_stop="confirmed";result.execution_status="failed";result.native_evidence={...control.native,state:"stopped"};
    await f.store.writeResult(record.task_id,result);
    const before=await readFile(join(f.store.taskDir(record.task_id),"result.json"));
    await reconcileStoredTasks(f.store);
    expect(await readFile(join(f.store.taskDir(record.task_id),"result.json"))).toEqual(before);
    expect((await f.store.readControl(record.task_id)).outcome).toBe("failed");
  }finally{await f.dispose();}
});
