import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { decodeCoordinationRequest, decodeCoordinationReply, coordinationRequestLane, COORDINATION_PAGE_BYTES } from '../../.passeur-core/src/contracts/coordination-service.js';
const parent = 'a'.repeat(64), repository = 'b'.repeat(24), id = '11111111-1111-1111-1111-111111111111';
const limits = { works: 10, cases: 10, notes: 10, receipts: 100, note_bytes: 1024 };
const req = (kind, fields = {}) => ({ schema_version: 1, kind, ...fields });
const read = (fields = {}) => req('read', { selector: { kind: 'work', id }, offset: 0, limit: 64, expected_hash: null, ...fields });
const closed = () => req('command', { command: { kind: 'close_work', operation_key: 'close', work_id: id, expected_revision: 1 } });
const commandReply = (request, fields = {}) => ({ schema_version: 1, kind: 'receipt', repository_id: repository, receipt: {
  owner: parent, key: request.command.operation_key, action: request.command.kind,
  request_hash: canonicalHash({ owner: parent, command: request.command }), revision: 2,
  entity: { kind: 'work', id }, item_id: id, outcome: 'recorded', ...fields,
} });
const page = (fields = {}) => ({ schema_version: 1, kind: 'page', repository_id: repository, selector: { kind: 'work', id },
  hash: 'd'.repeat(64), offset: 0, bytes: 4, next_offset: 4, total_bytes: 4, eof: true, content: 'null', ...fields });
const check = (request, value) => decodeCoordinationReply(decodeCoordinationRequest(request), parent, repository, value);

test('complete request decoding supports each implemented operation and copies nested input', () => {
  for (const value of [req('identity'), req('status'), req('initialize', { limits }), closed(), read()]) {
    assert.deepEqual(decodeCoordinationRequest(value), value);
  }
  const raw = req('initialize', { limits: { ...limits } }), decoded = decodeCoordinationRequest(raw);
  raw.limits.works = 1; assert.equal(decoded.limits.works, limits.works);
});
test('request versions distinguish malformed from unsupported representations', () => {
  for (const version of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => decodeCoordinationRequest({ schema_version: version, kind: 'identity' }), { code: 'COORDINATION_SERVICE_INVALID' });
  }
  assert.throws(() => decodeCoordinationRequest({ schema_version: 2, kind: 'identity' }), { code: 'COORDINATION_SERVICE_VERSION_UNSUPPORTED' });
});
test('unknown operations and unexpected authorization fields cannot dispatch', () => {
  assert.throws(() => decodeCoordinationRequest(req('approve')), { code: 'COORDINATION_SERVICE_OPERATION_UNSUPPORTED' });
  for (const extra of [{ owner_id: parent }, { source_view: '/another/repo' }, { approved: true }, { operator: true }]) {
    assert.throws(() => decodeCoordinationRequest({ ...req('identity'), ...extra }), { code: 'COORDINATION_SERVICE_INVALID' });
  }
});
test('nested command variants reject incomplete source and control identity', () => {
  const value = closed(); delete value.command.expected_revision;
  assert.throws(() => decodeCoordinationRequest(value), { code: 'COORDINATION_INVALID' });
  assert.throws(() => decodeCoordinationRequest(req('command', { command: { kind: 'register_work' } })), { code: 'COORDINATION_OPERATION_UNSUPPORTED' });
  assert.throws(() => decodeCoordinationRequest(req('command', { command: { kind: 'something_else' } })), { code: 'COORDINATION_OPERATION_UNSUPPORTED' });
});
test('enumerable accessors, inherited fields and hidden/symbol fields are rejected without execution', () => {
  let called = 0;
  const getter = { kind: 'identity' }; Object.defineProperty(getter, 'schema_version', { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => decodeCoordinationRequest(getter), { code: 'COORDINATION_SERVICE_INVALID' }); assert.equal(called, 0);
  for (const raw of [Object.assign(Object.create({}), req('identity')), Object.assign(req('identity'), { [Symbol()]: true })]) {
    assert.throws(() => decodeCoordinationRequest(raw), { code: 'COORDINATION_SERVICE_INVALID' });
  }
  const hidden = req('identity'); Object.defineProperty(hidden, 'secret', { value: 1 });
  assert.throws(() => decodeCoordinationRequest(hidden), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('null-prototype records and wire JSON have the same declared request meaning', () => {
  const value = Object.assign(Object.create(null), req('status'));
  assert.deepEqual(decodeCoordinationRequest(value), req('status'));
  assert.deepEqual(decodeCoordinationRequest(JSON.parse(JSON.stringify(closed()))), closed());
});
test('all read selectors have exact variant-specific fields', () => {
  for (const kind of ['work', 'case', 'note', 'overlaps']) assert.equal(decodeCoordinationRequest(read({ selector: { kind, id } })).selector.id, id);
  const receipt = read({ selector: { kind: 'receipt', operation_key: 'a-key' } });
  assert.equal(decodeCoordinationRequest(receipt).selector.operation_key, 'a-key');
  assert.throws(() => decodeCoordinationRequest(read({ selector: { kind: 'receipt', id } })), { code: 'COORDINATION_SERVICE_INVALID' });
  assert.throws(() => decodeCoordinationRequest(read({ selector: { kind: 'all-secret-tasks', id } })), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('continuation must identify the original view and use valid byte limits', () => {
  assert.throws(() => decodeCoordinationRequest(read({ offset: 1 })), { code: 'COORDINATION_SERVICE_INVALID' });
  for (const limit of [0, 1, 3, COORDINATION_PAGE_BYTES + 1, 1.5]) assert.throws(() => decodeCoordinationRequest(read({ limit })), { code: 'COORDINATION_SERVICE_INVALID' });
  assert.equal(decodeCoordinationRequest(read({ offset: 4, expected_hash: 'd'.repeat(64) })).offset, 4);
});
test('valid but excessive source scope does not escape the service message bound', () => {
  const areas = Array.from({ length: 8 }, (_, i) => ({ kind: 'file', path: `${i}${'a'.repeat(4095)}` }));
  assert.throws(() => decodeCoordinationRequest(req('command', { command: {
    kind: 'register_external_work', operation_key: 'register', input_oid: '1'.repeat(40), intent: '', areas, readers: [],
  } })), { code: 'COORDINATION_MESSAGE_TOO_LARGE' });
});
test('release and recovery have protected capacity but routine observations do not', () => {
  assert.equal(coordinationRequestLane(closed()), 'control');
  assert.equal(coordinationRequestLane(read({ selector: { kind: 'receipt', operation_key: 'recover' } })), 'control');
  for (const request of [req('identity'), req('status'), read(), req('initialize', { limits })]) assert.equal(coordinationRequestLane(request), 'ordinary');
  const share = readers => req('command', { command: { kind: 'share_work', operation_key: 's', work_id: id, expected_revision: 1, readers } });
  assert.equal(coordinationRequestLane(share([])), 'control'); assert.equal(coordinationRequestLane(share([parent])), 'ordinary');
});
test('identity response cannot substitute another parent or repository', () => {
  const valid = { schema_version: 1, kind: 'identity', repository_id: repository, parent_id: parent };
  assert.deepEqual(check(req('identity'), valid), valid);
  for (const fields of [{ parent_id: 'c'.repeat(64) }, { repository_id: 'c'.repeat(24) }, { privileged: true }]) {
    assert.throws(() => check(req('identity'), { ...valid, ...fields }), { code: 'COORDINATION_SERVICE_INVALID' });
  }
});
test('initialization output must be ready with the exact requested configuration', () => {
  const valid = { schema_version: 1, kind: 'status', repository_id: repository, state: 'ready', epoch: id, revision: 0, limits };
  assert.deepEqual(check(req('initialize', { limits }), valid), valid);
  assert.throws(() => check(req('initialize', { limits }), { schema_version: 1, kind: 'status', repository_id: repository, state: 'not_enabled' }), { code: 'COORDINATION_SERVICE_INVALID' });
  assert.throws(() => check(req('initialize', { limits }), { ...valid, limits: { ...limits, works: 1 } }), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('valid command reply proves actor, action, key, and subject correspondence', () => {
  const request = closed(), reply = commandReply(request); assert.deepEqual(check(request, reply), reply);
  for (const fields of [{ owner: 'c'.repeat(64) }, { key: 'other' }, { action: 'share_work' }, { item_id: randomUUID() }, { entity: { kind: 'case', id } }]) {
    assert.throws(() => check(request, commandReply(request, fields)), { code: 'COORDINATION_SERVICE_INVALID' });
  }
});
test('metadata command receipt hash must acknowledge the exact accepted command content', () => {
  const request = closed(); assert.throws(() => check(request, commandReply(request, { request_hash: 'f'.repeat(64) })), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('external registration reply acknowledges the derived registration action, not client-supplied workspace identity', () => {
  const request = req('command', { command: { kind: 'register_external_work', operation_key: 'r', input_oid: '1'.repeat(40), intent: '', areas: [], readers: [] } });
  const reply = commandReply(request, { key: 'r', action: 'register_work', revision: 1 });
  assert.equal(check(request, reply).receipt.action, 'register_work');
  assert.throws(() => check(request, commandReply(request, { key: 'r', action: 'register_work', entity: { kind: 'case', id } })), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('pages preserve exact selector and continuation identity', () => {
  assert.deepEqual(check(read(), page()), page());
  for (const fields of [{ selector: { kind: 'note', id } }, { offset: 1 }, { hash: 'bad' }]) {
    assert.throws(() => check(read(), page(fields)), { code: 'COORDINATION_SERVICE_INVALID' });
  }
  assert.throws(() => check(read({ expected_hash: 'e'.repeat(64) }), page()), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('page bytes, offsets, limits and eof are independently validated', () => {
  for (const fields of [{ bytes: 3 }, { next_offset: 3 }, { total_bytes: 3 }, { eof: false }, { content: 'nullx' },
    { content: '\ud800', bytes: 3, next_offset: 3, total_bytes: 3 }, { bytes: 0, next_offset: 0, content: '', total_bytes: 4, eof: false }]) {
    assert.throws(() => check(read(), page(fields)), { code: 'COORDINATION_SERVICE_INVALID' });
  }
  assert.throws(() => check(read({ limit: 4 }), page({ bytes: 5, next_offset: 5, total_bytes: 5, content: 'false' })), { code: 'COORDINATION_SERVICE_INVALID' });
});
test('reply version, extra fields and wrong kind are not accepted as successful data', () => {
  assert.throws(() => check(read(), { ...page(), schema_version: 2 }), { code: 'COORDINATION_SERVICE_VERSION_UNSUPPORTED' });
  assert.throws(() => check(read(), { ...page(), safe: true }), { code: 'COORDINATION_SERVICE_INVALID' });
  assert.throws(() => check(closed(), page()), { code: 'COORDINATION_SERVICE_INVALID' });
});
