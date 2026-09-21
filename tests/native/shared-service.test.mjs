import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { IpcConnection, decodeFrame } from '../../.passeur-native/src/service/transport.js';
import { processIdentity, sameProcess, privateDirectory, assertElectionGuard } from '../../.passeur-native/src/service/process.js';
const deferred = () => { let resolve; return { promise: new Promise(r => resolve=r), resolve: v=>resolve(v) }; };
async function directory(t) { const root=await mkdtemp(join(tmpdir(),'ps-native-')); t.after(()=>rm(root,{recursive:true,force:true})); return root; }
async function pair(t, handler=()=>{}) {
 const root=await directory(t), endpoint=join(root,'s'), accepted=deferred();
 const server=createServer(socket=>accepted.resolve(new IpcConnection(socket,handler)));
 server.listen(endpoint); await once(server,'listening');
 const socket=connect(endpoint); await once(socket,'connect'); const ipc=await accepted.promise;
 t.after(async()=>{socket.destroy();ipc.close();await ipc.closed;await new Promise(r=>server.close(r));});return{socket,ipc};
}
const frame={kind:'request',id:'one',generation:'service-generation',operation:'status',arguments:{}};
test('IPC decodes fragmented Unicode frames through a real Unix socket', async t=>{
 const received=deferred(), f=await pair(t,x=>received.resolve(x));const sent={...frame,arguments:{label:'hello 世界'}};const b=Buffer.from(JSON.stringify(sent)+'\n');
 f.socket.write(b.subarray(0,b.length-4));f.socket.write(b.subarray(b.length-4));assert.deepEqual(await received.promise,sent);
});
test('IPC rejects unknown envelope fields instead of handing them to an operation',async t=>{
 let calls=0;const f=await pair(t,()=>{calls++});f.socket.write(JSON.stringify({...frame,owner_id:'forged'})+'\n');await f.ipc.closed;assert.equal(calls,0);assert.equal(f.ipc.error.code,'SERVICE_FRAME_INVALID');
});
test('IPC closes oversized unterminated input before accumulating more than its frame limit',async t=>{
 const f=await pair(t);f.socket.on('error',()=>{});f.socket.write(Buffer.alloc(1048577,120));await f.ipc.closed;assert.equal(f.ipc.error.code,'SERVICE_FRAME_LIMIT');
});
test('IPC EOF with a partial frame retains a framing failure',async t=>{
 const f=await pair(t);f.socket.end('{"kind":');await f.ipc.closed;assert.equal(f.ipc.error.code,'SERVICE_FRAME_INVALID');
});
test('closing one connection does not interrupt another connection or its owned callback',async t=>{
 const gate=deferred(),entered=deferred(),done=deferred();
 const first=await pair(t),second=await pair(t,async()=>{entered.resolve();await gate.promise;done.resolve();});
 second.socket.write(JSON.stringify(frame)+'\n');await entered.promise;first.socket.end();await first.ipc.closed;assert.equal(second.ipc.isClosed,false);gate.resolve();await done.promise;
});
test('IPC correlation and direction metadata are required for all response variants',()=>{
 for(const value of [{kind:'response',result:{}},{...frame,kind:'unknown'},{kind:'failure',id:'x',generation:'g',error:{code:'X',message:'bad',token:'secret'}},{kind:'hello',protocol:2}]) assert.throws(()=>decodeFrame(value));
 assert.deepEqual(decodeFrame({kind:'cancel_wait',id:'w',generation:'g'}),{kind:'cancel_wait',id:'w',generation:'g'});
});
test('private control directory rejects permissive modes and symlink aliases',async t=>{
 const root=await directory(t),good=join(root,'private');await mkdir(good,{mode:0o700});assert.equal(await privateDirectory(good),good);
 await chmod(good,0o755);await assert.rejects(privateDirectory(good),{code:'SERVICE_PATH_UNSAFE'});await chmod(good,0o700);
 const alias=join(root,'alias');await symlink(good,alias);await assert.rejects(privateDirectory(alias),{code:'SERVICE_PATH_UNSAFE'});
});
test('Linux process birth evidence rejects changed start identity and lockless entry',async t=>{
 const identity=await processIdentity();assert.equal(await sameProcess(identity),true);assert.equal(await sameProcess({...identity,started:String(BigInt(identity.started)+1n)}),false);
 const root=await directory(t),lock=join(root,'guard');await writeFile(lock,'',{mode:0o600});await assert.rejects(assertElectionGuard(lock),{code:'SERVICE_ELECTION_REQUIRED'});
});
test('a paused elected process keeps the same guard; owner exit permits a new owner', {timeout:10000},async t=>{
 const root=await directory(t),lock=join(root,'guard');await writeFile(lock,'',{mode:0o600});
 const moduleUrl=pathToFileURL(join(process.cwd(),'.passeur-native/src/service/process.js')).href;
 const child=spawn('flock',['--nonblock','--no-fork',lock,process.execPath,'--input-type=module','-e',`import {assertElectionGuard} from ${JSON.stringify(moduleUrl)}; await assertElectionGuard(process.argv[1]); process.stdout.write('owned\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,lock],{stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');t.after(()=>{try{process.kill(child.pid,'SIGCONT');child.kill('SIGTERM')}catch{}});
 assert.match((await once(child.stdout,'data'))[0].toString(),/owned/);process.kill(child.pid,'SIGSTOP');
 for(let n=0;n<100;n++){const stat=await readFile(`/proc/${child.pid}/stat`,'utf8');if(stat.slice(stat.lastIndexOf(')')+2).startsWith('T'))break;if(n===99)throw Error('Owned test process did not stop');await delay(5);}
 const contender=spawn('flock',['--nonblock',lock,'true'],{stdio:'ignore'});assert.equal((await once(contender,'exit'))[0],1);
 process.kill(child.pid,'SIGCONT');child.stdin.end();assert.equal((await exited)[0],0);
 const next=spawn('flock',['--nonblock',lock,'true'],{stdio:'ignore'});assert.equal((await once(next,'exit'))[0],0);
});
