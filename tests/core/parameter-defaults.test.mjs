import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterDefaultValues } from '../../.passeur-core/src/observation/parameter-defaults.js';

// Deliberate native-node contract fixtures. These prove traversal rules, not grammar recognition;
// the required native parameter-default-masking suite exercises actual TypeScript and TSX parsing.
const node = (type, fields = {}, children = []) => ({ type, namedChildren: children,
  childForFieldName: name => fields[name] ?? null });
const value = () => node('string');
const parameter = pattern => node('required_parameter', { pattern });

test('collects an ordinary top-level parameter default', () => {
  const v = value(); assert.deepEqual(parameterDefaultValues([node('optional_parameter', { value: v })]), [v]);
});
test('collects nested object destructuring defaults through renamed pair patterns', () => {
  const v = value(), inner = node('object_assignment_pattern', { left: node('identifier'), right: v });
  const pair = node('pair_pattern', { key: node('property_identifier'), value: node('object_pattern', {}, [inner]) });
  assert.deepEqual(parameterDefaultValues([parameter(node('object_pattern', {}, [pair]))]), [v]);
});
test('collects array destructuring defaults and nested left patterns', () => {
  const a = value(), b = value();
  const nested = node('assignment_pattern', { left: node('array_pattern', {}, [node('assignment_pattern', { left: node('identifier'), right: b })]), right: a });
  assert.deepEqual(parameterDefaultValues([parameter(node('array_pattern', {}, [nested]))]), [a, b]);
});
test('does not reinterpret literal type syntax as an initializer', () => {
  const v = value(); const p = node('required_parameter', { pattern: node('identifier'), type: node('type_annotation', {}, [node('assignment_pattern', { right: v })]) });
  assert.deepEqual(parameterDefaultValues([p]), []);
});
test('does not descend into initializer expressions or computed keys', () => {
  const unrelated = value(), init = node('function_expression', {}, [node('assignment_pattern', { right: unrelated })]);
  const pair = node('pair_pattern', { key: node('computed_property_name', {}, [node('assignment_pattern', { right: unrelated })]),
    value: node('assignment_pattern', { left: node('identifier'), right: init }) });
  assert.deepEqual(parameterDefaultValues([parameter(node('object_pattern', {}, [pair]))]), [init]);
});
test('walks deeply nested patterns without recursive call-stack growth', () => {
  const v = value(); let pattern = node('object_assignment_pattern', { right: v });
  for (let n = 0; n < 10000; n++) pattern = node('array_pattern', {}, [pattern]);
  assert.deepEqual(parameterDefaultValues([parameter(pattern)]), [v]);
});
