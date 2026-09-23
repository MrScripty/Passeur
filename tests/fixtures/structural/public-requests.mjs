// Explicit examples of the existing metadata contract; no parser, model or schema implementation.
export const parent = 'b'.repeat(64);
export const id = '11111111-2222-3333-4444-555555555555';
export const other = '22222222-3333-4444-5555-666666666666';
export const oid = 'a'.repeat(40);
const key = 'public-operation';
const fields = { operation_key: key, case_id: id, expected_revision: 1, generation: 1 };
export const publicRequests = [
 ['passeur_coordination', {schema_version:1,kind:'identity'}],
 ['passeur_coordination', {schema_version:1,kind:'status'}],
 ...['work','note','case','overlaps'].map(kind => ['passeur_coordination', {schema_version:1,kind:'read',selector:{kind,id},offset:0,limit:256,expected_hash:null}]),
 ['passeur_coordination', {schema_version:1,kind:'read',selector:{kind:'receipt',operation_key:key},offset:0,limit:256,expected_hash:null}],
 ...[
  ['passeur_work', {kind:'register_external_work',operation_key:key,input_oid:oid,intent:'Compare declarations',areas:[{kind:'file',path:'src/main.ts'}],readers:[parent]}],
  ['passeur_work', {kind:'share_work',operation_key:key,work_id:id,expected_revision:1,readers:[parent]}],
  ['passeur_work', {kind:'close_work',operation_key:key,work_id:id,expected_revision:1}],
  ...['intent','question','statement','agreement_proposal','resolution_update'].map(note_kind => ['passeur_notes', {kind:'post_note',operation_key:key,subject:{kind:'work',id},note_kind,text:'Parent-authored statement',parties:note_kind === 'agreement_proposal' ? [parent] : []}]),
  ...['ack_note','withdraw_note'].map(kind => ['passeur_notes', {kind,operation_key:key,note_id:id}]),
  ['passeur_reconciliation', {kind:'claim_target',operation_key:key,target:'refs/heads/main',members:[parent]}],
  ['passeur_reconciliation', {kind:'select_inputs',...fields,target_oid:oid,inputs:[{work_id:id,commit_oid:oid}]}],
  ...['begin_external_integration','record_external_settlement','release_case'].map(kind => ['passeur_reconciliation',{kind,...fields}]),
  ['passeur_reconciliation', {kind:'transfer_case',...fields,new_lead:parent}],
 ].map(([tool,command]) => [tool,{schema_version:1,kind:'command',command}]),
];
export const initialization = {schema_version:1,kind:'initialize',limits:{works:32,cases:8,notes:32,receipts:256,note_bytes:1024}};
