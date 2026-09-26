// Actual canonical operation schema; runtime and native evidence are separate gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { operationSchemas } from '../../.passeur-core/src/contracts/service.js';

// Schema selection belongs to the actual private/public canonical operation.
test('source report selector is bounded and rejects duplicate paths', () => {
  const id='00000000-0000-4000-8000-000000000001';
  assert.equal(operationSchemas.structural_report.safeParse({work_id:id,paths:['src/z.ts']}).success,true);
  assert.equal(operationSchemas.structural_report.safeParse({work_id:id,paths:[]}).success,false);
  assert.equal(operationSchemas.structural_report.safeParse({work_id:id,paths:['x.ts','x.ts']}).success,false);
  assert.equal(operationSchemas.structural_report.safeParse({work_id:id,paths:['a','b','c','d','e']}).success,false);
  assert.equal(operationSchemas.structural_report.parse({work_id:id}).view,'comparison');
  for (const view of ['comparison','input','observed'])
    assert.equal(operationSchemas.structural_report.safeParse({work_id:id,view}).success,true);
  assert.equal(operationSchemas.structural_report.safeParse({work_id:id,view:'unknown'}).success,false);
});

test('an exact selected file bypasses the default four-file prefix without granting out-of-scope reads', async t => {
  const { runtimeFixture } = await import('../fixtures/structural/runtime-fixture.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await runtimeFixture(t); await f.initialize();
  await mkdir(join(f.root,'src'));
  for (const name of ['a.ts','b.ts','c.ts','d.ts','e.ts','z.ts'])
    await writeFile(join(f.root,'src',name),'export function item(value: string): string { return value; }\n');
  const receipt = await f.call(f.register({areas:[{kind:'subtree',path:'src'}]}),f.ordinary);
  const id = receipt.receipt.item_id;
  const paths=['src/z.ts'];
  const request=f.runtime.structuralReport(id,f.ordinary,f.root,undefined,paths);
  paths[0]='source.ts'; // An in-process caller cannot change an already captured selection during suspension.
  const report=await request;
  assert.equal(report.reports.length,1); assert.equal(report.reports[0].path,'src/z.ts');
  await assert.rejects(f.runtime.structuralReport(id,f.ordinary,f.root,undefined,['source.ts']),{code:'STRUCTURAL_SOURCE_FORBIDDEN'});
  await assert.rejects(f.runtime.structuralReport(id,f.ordinary,f.root,undefined,['../outside.ts']),{code:'SOURCE_PATH_INVALID'});
  assert.equal(f.counts.profile,0);
});
