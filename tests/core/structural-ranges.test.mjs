import test from 'node:test';
import assert from 'node:assert/strict';
import { Utf8SourceRanges } from '../../.passeur-core/src/observation/ranges.js';

test('native string indices map to captured UTF-8 byte intervals', () => {
  const ranges = new Utf8SourceRanges('\uFEFFé\r\nx😀e\u0301');
  assert.deepEqual(ranges.byteRange(0, 1), { start_byte: 0, end_byte: 3 });
  assert.deepEqual(ranges.byteRange(1, 2), { start_byte: 3, end_byte: 5 });
  assert.deepEqual(ranges.byteRange(2, 4), { start_byte: 5, end_byte: 7 });
  assert.deepEqual(ranges.byteRange(5, 7), { start_byte: 8, end_byte: 12 });
  assert.deepEqual(ranges.byteRange(7, 9), { start_byte: 12, end_byte: 15 });
  assert.equal(ranges.byteOffset(9), 15);
});

test('range mapping rejects a split surrogate and invalid parser indices', () => {
  const ranges = new Utf8SourceRanges('a😀b');
  assert.throws(() => ranges.byteOffset(2), { code: 'SOURCE_RANGE_INVALID' });
  assert.throws(() => ranges.byteOffset(-1), { code: 'SOURCE_RANGE_INVALID' });
  assert.throws(() => ranges.byteOffset(5), { code: 'SOURCE_RANGE_INVALID' });
  assert.throws(() => ranges.byteRange(4, 0), { code: 'SOURCE_RANGE_INVALID' });
  assert.throws(() => new Utf8SourceRanges('\ud83d'), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
});
