// Real observation persistence with explicitly supplied authorization. This checks historical
// projection handling, not parser correctness or host authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, A } from '../fixtures/structural/service-fixture.mjs';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { ObservationStore } from '../../.passeur-core/src/store/observation-store.js';
import { readCommittedFile, captureWorkingFile, sourceReference } from '../../.passeur-core/src/observation/source.js';
import { nativeParserIdentity } from '../../.passeur-core/src/observation/native-parser.js';

test('old TypeScript compact reports require refresh while exact captures remain available under detail authority', async t => {
  const f = await serviceFixture(t); await f.initialize();
  const coordination = await CoordinationStore.open(f.state, f.repositoryId, f.authority.assertOwned);
  const store = await ObservationStore.initialize(coordination, f.authority.assertOwned);
  f.sessions.push({close:()=>store.close()});
  const work_id=randomUUID();
  const input=await readCommittedFile(f.root,f.base,'source.ts',{max_bytes:8192});
  const observed=await captureWorkingFile({root:f.root,workspace_id:'fixture-source',workspace_generation:1,capture_sequence:1,input_commit_oid:f.base},'source.ts',{max_bytes:8192});
  const comparison={input:sourceReference(input),observed:sourceReference(observed),dialect:'typescript',
    parser_identity:nativeParserIdentity('typescript'),extractor_identity:'native-declarations@1',
    coverage:'complete',changes:[],region_changed:false,limitations:[]};
  const report={work_id,parent_id:A.owner_id,attribution:'observed_in_work_authorship_not_established',comparison};
  const authority=(recipient,id)=>{assert.equal(recipient,A.owner_id);assert.equal(id,work_id);};
  const retained=await store.publish({report,work_revision:1,workspace_generation:1,control_generation:null,input,observed,recipients:[]});
  await assert.rejects(store.readReport(retained.id,A.owner_id,authority),{code:'STRUCTURAL_REPORT_REFRESH_REQUIRED'});
  assert.equal((await store.readDetail(retained.id,A.owner_id,'observed',0,6,authority)).text,'export');
  assert.equal((await store.readRetainedPair(retained.id,A.owner_id,authority)).observed.text,observed.text);
  await access(join(coordination.root,'observation','artifacts',`${retained.id}.json`));
  const corrected=await store.publish({report:{...report,comparison:{...comparison,extractor_identity:'native-declarations@2'}},
    work_revision:1,workspace_generation:1,control_generation:null,input,observed,recipients:[]});
  assert.notEqual(corrected.id,retained.id);
  assert.ok((await store.readReport(corrected.id,A.owner_id,authority)).text.includes('native-declarations@2'));
  // Normal bounded eviction remains owned by ObservationStore; the refresh check itself is read-only.
});
