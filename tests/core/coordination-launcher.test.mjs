import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm, access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile), source=fileURLToPath(new URL('../../passeur',import.meta.url));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'passeur-launcher-')), installed=join(root,'installation with spaces');
 t.after(async()=>{await rm(root,{recursive:true});await assert.rejects(access(root),{code:'ENOENT'});if(process.env.PASSEUR_TEST_RESOURCE_LOG)await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,JSON.stringify({root,test:t.name,outcome:'removed-test-owned-launcher-fixture'})+'\n')});
 await mkdir(join(installed,'dist/src'),{recursive:true});await copyFile(source,join(installed,'passeur'));
 // The wrapper is the real subject; this explicit receiver proves only argv preservation, not CLI behavior.
 await writeFile(join(installed,'dist/src/cli.js'),'console.log(JSON.stringify(process.argv.slice(2)))\n');
 return {root,installed,call:async args=>JSON.parse((await run('bash',[join(installed,'passeur'),...args],{cwd:root})).stdout)};
}
test('launcher admits coordinate and preserves positional project and literal request arguments',async t=>{
 const f=await fixture(t), project=join(f.root,'target with spaces'), file='$(touch should-not-exist).json';
 assert.deepEqual(await f.call(['coordinate',project,'--request',file,'--yes']),['coordinate','--project',project,'--request',file,'--yes']);
 await assert.rejects(access(join(f.root,'should-not-exist')),{code:'ENOENT'});
});
test('launcher coordinate uses caller directory when no positional project is supplied',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.call(['coordinate','--request','identity.json']),['coordinate','--project',f.root,'--request','identity.json']);
});
test('existing launcher commands and unsupported-command rejection are preserved',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.call(['tasks']),['tasks','--project',f.root]);
 await assert.rejects(f.call(['not-a-supported-action']),e=>{assert.match(e.stderr,/Unknown Passeur action/);return true});
});
