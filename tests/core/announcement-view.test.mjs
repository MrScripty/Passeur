import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { announcementReceipt, announcementPage, ANNOUNCEMENT_PAGE_BYTES } from '../../.passeur-core/src/mcp/announcement-view.js';

function announcement(context = 'PRIVATE_CONTEXT'.repeat(2000)) {
  return { schema_version: 1, record: { id: '00000000-0000-4000-8000-000000000001', owner: 'a'.repeat(64),
    revision: 1, state: 'unresolved', payload_ref: '00000000-0000-4000-8000-000000000001',
    payload_digest: 'b'.repeat(64), source_view: '/repo', assignment_hash: 'b'.repeat(64),
    areas: [{ kind: 'subtree', path: 'src' }], readers: [] },
    assignment: { schema_version: 3, request_key: 'large-assignment', agent_id: 'fixture', mode: 'implement',
      objective: 'Keep the original assignment intact', context, acceptance_criteria: ['Return a compact receipt'],
      allowed_paths: ['src'], base_commit: 'c'.repeat(40), target_ref: 'refs/heads/main' } };
}
// This independently calculates the current public output framing size. Actual SDK delivery has its own test.
const framedBytes = value => Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('large valid assignment receives only a compact versioned receipt', () => {
  const value = announcement(), copy = structuredClone(value), receipt = announcementReceipt(value);
  assert.ok(framedBytes(value) > 24576);
  assert.ok(framedBytes(receipt) < 1024);
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.kind, 'announcement_receipt');
  assert.equal(receipt.record.id, value.record.id);
  assert.equal(receipt.record.payload_digest, value.record.payload_digest);
  assert.equal(receipt.payload.sha256, sha(JSON.stringify(value.assignment)));
  assert.equal(receipt.payload.bytes, Buffer.byteLength(JSON.stringify(value.assignment)));
  assert.equal(JSON.stringify(receipt).includes('PRIVATE_CONTEXT'), false);
  assert.equal('assignment' in receipt, false);
  assert.deepEqual(value, copy);
});

test('linked receipt retains task identity without returning source areas or prompt', () => {
  const value = announcement(); value.record.state = 'linked'; value.record.revision = 3; value.record.task_id = '00000000-0000-4000-8000-000000000002';
  const receipt = announcementReceipt(value);
  assert.equal(receipt.record.task_id, value.record.task_id);
  assert.equal(receipt.record.state, 'linked');
  assert.equal('areas' in receipt.record, false);
  assert.equal('readers' in receipt.record, false);
});

for (const [name, context, limit] of [
  ['ASCII', 'x'.repeat(32000), 4096],
  ['multibyte and CRLF', '\ufeff🙂e\u0301漢字\r\n'.repeat(1500), 127],
  ['minimum page', '🙂漢字'.repeat(40), 4],
  ['JSON escaping', '\\"\n\t\u0001'.repeat(5000), 4096],
]) test(`authorized payload paging reconstructs exact assignment: ${name}`, () => {
  const value = announcement(context), encoded = Buffer.from(JSON.stringify(value.assignment));
  const receipt = announcementReceipt(value); let offset = 0; const parts = [];
  while (offset < encoded.length) {
    const page = announcementPage(value, { offset, limit, expected_sha256: receipt.payload.sha256 });
    assert.equal(page.schema_version, 2); assert.equal(page.kind, 'announcement_payload_page');
    assert.equal(page.offset, offset); assert.equal(page.payload_sha256, receipt.payload.sha256);
    assert.equal(page.bytes, Buffer.byteLength(page.content));
    assert.ok(page.bytes > 0 && page.bytes <= limit);
    assert.equal(page.next_offset, offset + page.bytes); assert.equal(page.total_bytes, encoded.length);
    assert.ok(framedBytes(page) <= 24576, `framed bytes: ${framedBytes(page)}`);
    parts.push(page.content); offset = page.next_offset;
    assert.equal(page.eof, offset === encoded.length);
  }
  assert.equal(parts.join(''), encoded.toString('utf8'));
  assert.deepEqual(JSON.parse(parts.join('')), value.assignment);
  const end = announcementPage(value, { offset, limit, expected_sha256: receipt.payload.sha256 });
  assert.equal(end.bytes, 0); assert.equal(end.eof, true);
});

test('continued reads require and verify immutable payload identity', () => {
  const a = announcement('first'), b = announcement('second');
  assert.throws(() => announcementPage(a, { offset: 1, limit: 4 }), { code: 'ANNOUNCEMENT_HASH_REQUIRED' });
  assert.throws(() => announcementPage(b, { offset: 1, limit: 4, expected_sha256: announcementReceipt(a).payload.sha256 }), { code: 'ANNOUNCEMENT_PAYLOAD_CHANGED' });
});
test('metadata revision changes do not change immutable payload identity', () => {
  const a = announcement('same'), b = structuredClone(a); b.record.revision++; b.record.state = 'bound';
  assert.deepEqual(announcementReceipt(a).payload, announcementReceipt(b).payload);
});
test('a byte offset inside a multibyte character is rejected', () => {
  const value = announcement('🙂'); const bytes = Buffer.from(JSON.stringify(value.assignment));
  const offset = bytes.indexOf(Buffer.from('🙂')) + 1;
  assert.throws(() => announcementPage(value, { offset, limit: 4, expected_sha256: sha(bytes) }), { code: 'ANNOUNCEMENT_RANGE_INVALID' });
});
for (const invalid of [
  { offset: -1, limit: 4 }, { offset: NaN, limit: 4 }, { offset: 0.5, limit: 4 },
  { offset: 0, limit: 3 }, { offset: 0, limit: ANNOUNCEMENT_PAGE_BYTES + 1 },
  { offset: 0, limit: 4, expected_sha256: 'bad' },
]) test(`page rejects invalid request ${JSON.stringify(invalid)}`, () => {
  assert.throws(() => announcementPage(announcement('short'), invalid), { code: 'ANNOUNCEMENT_RANGE_INVALID' });
});
test('a cursor beyond the payload is rejected', () => {
  const value = announcement('short'); const receipt = announcementReceipt(value);
  assert.throws(() => announcementPage(value, { offset: receipt.payload.bytes + 1, limit: 4, expected_sha256: receipt.payload.sha256 }), { code: 'ANNOUNCEMENT_RANGE_INVALID' });
});
