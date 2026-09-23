// Real Git, filesystem inventory and watcher scheduling. The analyzer deliberately returns
// path evidence only; native extraction and authenticated report delivery have separate gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDeclaredSourcePaths } from '../../.passeur-core/src/observation/source-inventory.js';
import { ObservationMonitor } from '../../.passeur-core/src/observation/monitor.js';
const exec = promisify(execFile);
async function git(root,...args) { return (await exec('git',['-C',root,...args])).stdout.trim(); }
async function fixture(t, count = 270) {
  const root = await mkdtemp(join(tmpdir(),'passeur-inventory-progress-'));
  const disposers=[];
  t.after(async () => { try { for(const dispose of disposers.reverse()) await dispose(); } finally { await rm(root,{recursive:true,force:true}); } });
  await git(root,'init','-q','-b','main'); await mkdir(join(root,'src'));
  const names = Array.from({length:count},(_,i)=>`src/a${String(i).padStart(4,'0')}.ts`);
  names.push('src/z.ts');
  for(const name of names) await writeFile(join(root,name),'export function f(value: string): string { return value; }\n');
  await git(root,'add','.');
  await git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture');
  return {root, names, base:await git(root,'rev-parse','HEAD'), beforeCleanup:dispose=>disposers.push(dispose)};
}
const areas = [{kind:'subtree',path:'src'}];
function until(predicate, label) {
  return new Promise((resolve,reject) => {
    const deadline = setTimeout(()=>{clearInterval(interval);reject(new Error(label));},20000);
    const interval = setInterval(()=>{if(predicate()){clearTimeout(deadline);clearInterval(interval);resolve();}},10);
  });
}

test('actual inventory continues beyond its bounded first page with exact declared paths', async t => {
  const f=await fixture(t); const seen=new Set(); let after_path;
  for(let n=0;n<5;n++) {
    const page=await listDeclaredSourcePaths(f.root,f.base,areas,256,undefined, after_path===undefined?{}:{after_path});
    assert.ok(page.paths.length<=256); for(const path of page.paths)seen.add(path);
    if(page.next_path===undefined)break;
    after_path=page.next_path;
  }
  assert.deepEqual([...seen].sort(),f.names);
});
test('explicit watch under a broad subtree and locally changed late file take priority', async t => {
  const f=await fixture(t);
  const watched=await listDeclaredSourcePaths(f.root,f.base,[...areas,{kind:'file',path:'src/z.ts'}],4);
  assert.equal(watched.paths[0],'src/z.ts');
  await writeFile(join(f.root,'src/z.ts'),'export function f(value: number): number { return value; }\n');
  const hinted=await listDeclaredSourcePaths(f.root,f.base,areas,4,undefined,{priority_paths:['src/z.ts']});
  assert.ok(hinted.paths.includes('src/z.ts'));
  await git(f.root,'add','src/z.ts');
  await git(f.root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','changed source');
  const committed=await listDeclaredSourcePaths(f.root,f.base,areas,4);
  assert.ok(committed.paths.includes('src/z.ts'));
});
test('path priority never follows a source symlink outside its declared area', async t => {
  const f=await fixture(t,4);
  const outside=join(f.root,'outside.ts'); await writeFile(outside,'PRIVATE_OUTSIDE');
  await symlink('../outside.ts',join(f.root,'src/escape.ts'));
  const page=await listDeclaredSourcePaths(f.root,f.base,areas,4,undefined,{priority_paths:['src/escape.ts']});
  assert.equal(page.paths.includes('src/escape.ts'),false);
  assert.ok(page.limitations.includes('source_inventory_unsafe_or_changed'));
});
test('actual monitor reaches the last inventory page and observes a later filesystem edit', async t => {
  const f=await fixture(t); const calls=[]; let lateEdit=false, editedObserved=false;
  const monitor=new ObservationMonitor({
    analyze:async job=>{
      calls.push([...job.paths]); assert.ok(job.paths.length<=16);
      if(lateEdit&&job.paths.includes('src/z.ts'))editedObserved=true;
      return {kind:'artifact', evidence_id:`${job.generation}:${job.paths.join(',')}`, artifact:job.paths};
    },
    publish:async(_job,_artifact,current)=>{assert.equal(current(),true);},
  });
  f.beforeCleanup(()=>monitor.close());
  const workspace={work_id:'work',work_revision:1,control_generation:1,workspace_id:'workspace',workspace_generation:1,
    root:f.root,input_commit_oid:f.base,areas};
  await monitor.attach(workspace);
  await until(()=>new Set(calls.flat()).size===f.names.length,'monitor starved the final inventory page');
  await until(()=>!monitor.status('work','workspace')?.limitations.includes('analysis_batch_pending'),'inventory cycle did not settle');
  const mark=calls.length; lateEdit=true;
  await writeFile(join(f.root,'src/z.ts'),'export function f(value: boolean): boolean { return value; }\n');
  await until(()=>editedObserved,'actual watcher did not observe the late edit');
  assert.ok(calls.slice(mark).some(paths=>paths.includes('src/z.ts')));
});
