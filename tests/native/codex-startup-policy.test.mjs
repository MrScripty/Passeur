import test from 'node:test';
import assert from 'node:assert/strict';
import { startupRequirementFromFlags, resolveStartupRequirement, inspectStartupRequirement } from '../../.passeur-native/src/codex/startup-policy.js';

for (const [required, optional, expected] of [[undefined, undefined, undefined], [true, undefined, true], [undefined, true, false]]) {
  test(`startup flags select ${String(expected)} without inferring host state`, () => {
    assert.equal(startupRequirementFromFlags(required, optional), expected);
  });
}
test('contradictory startup flags are rejected before configuration work', () => {
  assert.throws(() => startupRequirementFromFlags(true, true), { code: 'ARGUMENT_INVALID' });
});
for (const previous of [true, false]) {
  test(`an unspecified update preserves required=${previous}`, () => {
    assert.equal(resolveStartupRequirement(undefined, previous), previous);
  });
}
test('new registrations remain optional unless explicitly required', () => {
  assert.equal(resolveStartupRequirement(undefined, undefined), false);
  assert.equal(resolveStartupRequirement(true, undefined), true);
});
test('explicit operator choices override the selected server policy', () => {
  assert.equal(resolveStartupRequirement(false, true), false);
  assert.equal(resolveStartupRequirement(true, false), true);
});
test('malformed prior policy is rejected rather than coerced or repaired silently', () => {
  for (const previous of [null, 'true', 1, [], {}]) {
    assert.throws(() => resolveStartupRequirement(undefined, previous), { code: 'CODEX_CONFIG_INVALID' });
    assert.throws(() => resolveStartupRequirement(true, previous), { code: 'CODEX_CONFIG_INVALID' });
  }
});
test('a dynamically invalid requested policy cannot cross the registration boundary', () => {
  for (const requested of [null, 'true', 1, [], {}]) {
    assert.throws(() => resolveStartupRequirement(requested, undefined), { code: 'REGISTRATION_INVALID' });
  }
});
test('missing get-json field remains not-reported even for a required registration', () => {
  assert.deepEqual(inspectStartupRequirement(undefined, true), { status: 'not_reported' });
  assert.deepEqual(inspectStartupRequirement(undefined, false), { status: 'not_reported' });
});
test('explicit host observations must match the selected policy', () => {
  assert.deepEqual(inspectStartupRequirement(true, true), { status: 'matched', required: true });
  assert.deepEqual(inspectStartupRequirement(false, undefined), { status: 'matched', required: false });
  assert.throws(() => inspectStartupRequirement(false, true), { code: 'CODEX_REGISTRATION_MISMATCH' });
  assert.throws(() => inspectStartupRequirement(true, false), { code: 'CODEX_REGISTRATION_MISMATCH' });
});
test('malformed host evidence is not treated as absent or successful', () => {
  for (const actual of [null, 'true', 1, [], {}]) {
    assert.throws(() => inspectStartupRequirement(actual, true), { code: 'CODEX_INSPECTION_UNSUPPORTED' });
  }
});
