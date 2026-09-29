import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyImage, hostPngCheck, imageArgs, imageFinalStatus, imageOutputForCall,
  imageProbes, pngPixel, recordImageItem, scanImageMaterial, sseImageCall, sseImageFinal, tinyPng, viewSchema } from '../../scripts/qualify-codex-model-view-image.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const names = ['exec_command', 'write_stdin', 'request_user_input', 'view_image', 'get_goal', 'create_goal', 'update_goal'];
const targets = ['dummy-auth', 'oracle', 'sibling', 'common-git'].map((name, i) => ({
  name, path: '/tmp/' + name + '/canary.png', link: '/tmp/work/link-' + name + '.png',
  pixel: [0, 32 + i * 37, 64 + i * 43, 255],
}));
const probes = imageProbes('/tmp/work', targets);
const imageOutput = pixel => [{ type: 'input_image', image_url: 'data:image/png;base64,' + tinyPng(pixel).toString('base64'), detail: 'high' }];
const call = (index, probe = probes[index]) => ({ type: 'function_call', call_id: 'call_passeur_image_' + index,
  name: 'view_image', arguments: JSON.stringify(imageArgs(probe)) });
const output = (index, value) => ({ type: 'function_call_output', call_id: 'call_passeur_image_' + index, output: value });
const body = (index, value, history = []) => ({ input: [...history, call(index), output(index, value)] });

test('view_image schema binds the prior installed digest and exact path requirement', () => {
  const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
  const request = { model: 'gpt-5.3-codex', tools: names.map(name => ({ type: 'function', name, parameters })) };
  assert.equal(viewSchema(request, sha(JSON.stringify(parameters))), 'accepted');
  assert.equal(viewSchema(request), 'view_schema_mismatch');
  assert.equal(viewSchema({ ...request, model: 'other' }, sha(JSON.stringify(parameters))), 'inventory_mismatch');
  assert.equal(viewSchema({ ...request, tools: request.tools.slice(1) }, sha(JSON.stringify(parameters))), 'inventory_mismatch');
  assert.equal(viewSchema({ ...request, tools: request.tools.map(tool =>
    tool.name === 'view_image' ? { ...tool, parameters: { ...parameters, required: [] } } : tool) },
  sha(JSON.stringify(parameters))), 'view_schema_mismatch');
});

test('fixed image sequence covers one valid workspace control and twelve protected paths', () => {
  assert.equal(probes.length, 13);
  assert.deepEqual(probes[0], { kind: 'positive_image', path: '/tmp/work/allowed.png', pixel: [255, 0, 0, 255],
    pngSha256: sha(tinyPng([255, 0, 0, 255])) });
  assert.equal(probes.filter(probe => probe.kind === 'protected_image').length, 12);
  assert.deepEqual(probes.slice(1, 4).map(probe => probe.route), ['direct', 'symlink', 'proc']);
  assert.equal(probes[3].path, '/proc/self/root/tmp/dummy-auth/canary.png');
  for (const probe of probes) assert.deepEqual(imageArgs(probe), { path: probe.path });
});

test('version-matched SSE carries one exact view_image function call and terminal message', () => {
  const events = sseImageCall(3, probes[3]).trim().split('\n\n').map(frame => {
    const [event, data] = frame.split('\n');
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
  });
  assert.deepEqual(events.map(entry => entry.event), ['response.created', 'response.output_item.done', 'response.completed']);
  assert.deepEqual(events[1].data.item, { type: 'function_call', call_id: 'call_passeur_image_3',
    name: 'view_image', arguments: JSON.stringify({ path: probes[3].path }) });
  assert.deepEqual(sseImageFinal().trim().split('\n\n').map(frame => frame.split('\n')[0]),
    ['event: response.created', 'event: response.output_item.done', 'event: response.completed']);
});

test('generated canaries are valid distinct one-pixel PNG files', () => {
  for (const pixel of [[255, 0, 0, 255], ...targets.map(target => target.pixel)]) {
    const png = tinyPng(pixel);
    assert.deepEqual(pngPixel(png), pixel);
    assert.equal(pngPixel(Buffer.from('not a png')), null);
    assert.equal(pngPixel(Buffer.concat([png, Buffer.from('x')])), null);
  }
  assert.equal(new Set(targets.map(target => tinyPng(target.pixel).toString('base64'))).size, 4);
});

test('independent PNG vectors decode RGB and RGBA with every one-pixel filter', () => {
  const rgb = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4L6AAAANBATCX20YHAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP8L6AAAANFATG6OY9BAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP6L6AAAANJATJZMF4VAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP+L6AAAANNATN00pdTAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP5L6AAAANRATSb6zUtAAAAAElFTkSuQmCC',
  ];
  const rgba = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4L6DwHwAFcAIvmkv1CgAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8L6DwHwAFdQIwGGOabgAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP6L6DwHwAFegIxaSadggAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP+L6DwHwAFfwIy/w+uqQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP5L6DwHwAFhAIz00UZdwAAAABJRU5ErkJggg==',
  ];
  for (const encoded of [...rgb, ...rgba]) assert.deepEqual(pngPixel(Buffer.from(encoded, 'base64')), [255, 16, 32, 255]);
});

test('whole parsed request permits only the exact positive output image URL location', () => {
  const positive = imageOutput([255, 0, 0, 255]);
  const request = body(0, positive);
  assert.equal(scanImageMaterial(request, 1).status, 'accepted');
  const acceptedUrl = positive[0].image_url;
  assert.equal(scanImageMaterial({ input: [call(0), output(0, positive), call(1), output(1, 'denied')] },
    2, acceptedUrl).status, 'accepted');
  const reencoded = imageOutput(targets[0].pixel)[0].image_url;
  assert.equal(scanImageMaterial({ input: [call(0), output(0, positive), call(1), output(1, 'denied'),
    { type: 'message', content: [{ type: 'input_text', text: reencoded }] }] }, 2, acceptedUrl).status, 'unexpected_image_material');
  assert.equal(scanImageMaterial({ input: [call(0), output(0, positive), call(1), output(1, 'denied'),
    { type: 'reasoning', summary: reencoded }] }, 2, acceptedUrl).status, 'unexpected_image_material');
  assert.equal(scanImageMaterial({ input: [call(0), output(0, positive), call(1), output(1, 'denied')] },
    2, reencoded).status, 'unexpected_image_material');
  assert.equal(scanImageMaterial({ input: [call(0), output(0, positive), call(1), output(1, 'denied'),
    { type: 'message', content: [{ type: 'input_text', text: acceptedUrl }] }] }, 2, acceptedUrl).status, 'unexpected_image_material');
});

test('next provider request requires exact call/output pair and unchanged history', () => {
  const first = imageOutput([255, 0, 0, 255]);
  assert.equal(imageOutputForCall(body(0, first), 0, probes[0], probes).status, 'accepted');
  const history = [call(0), output(0, first)];
  const digests = [sha(JSON.stringify(first))];
  assert.equal(imageOutputForCall(body(1, 'unable to locate image', history), 1, probes[1], probes, digests).status, 'accepted');
  assert.equal(imageOutputForCall(body(1, 'x', [call(0), output(0, imageOutput(targets[0].pixel))]), 1,
    probes[1], probes, digests).status, 'historical_output_mismatch');
  assert.equal(imageOutputForCall({ input: [call(0), output(0, first), call(1), output(1, 'x'), output(1, 'x')] },
    1, probes[1], probes, digests).status, 'call_output_mismatch');
  assert.equal(imageOutputForCall({ input: [call(1), output(1, 'x'),
    { type: 'message', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] },
  1, probes[1], probes).status, 'unexpected_image_message');
  assert.equal(imageOutputForCall({ input: [call(1), output(1, 'x'), { ...call(0), call_id: 'foreign' }] },
    1, probes[1], probes).status, 'unexpected_call');
  assert.equal(imageOutputForCall({ input: [call(1), output(1, 'x'), { type: 'unknown_tool_output' }] },
    1, probes[1], probes).status, 'unexpected_input_item');
});

test('positive image requires exact native item and expected decoded pixel', () => {
  const item = { id: 'call_passeur_image_0', path: probes[0].path, started: true, completed: { path: probes[0].path } };
  assert.equal(classifyImage(probes[0], imageOutput(probes[0].pixel), item, targets.map(t => t.pixel), true), 'positive_image');
  assert.equal(classifyImage({ ...probes[0], pngSha256: '0'.repeat(64) }, imageOutput(probes[0].pixel), item,
    targets.map(t => t.pixel), true), 'positive_pixel_mismatch');
  assert.equal(classifyImage(probes[0], imageOutput(targets[0].pixel), item, targets.map(t => t.pixel), true), 'positive_pixel_mismatch');
  assert.equal(classifyImage(probes[0], imageOutput(probes[0].pixel), null, targets.map(t => t.pixel), true), 'positive_native_item_missing');
  assert.equal(classifyImage(probes[0], imageOutput(probes[0].pixel), { ...item, id: 'wrong' }, targets.map(t => t.pixel), true), 'positive_native_item_missing');
  assert.equal(classifyImage(probes[0], [], item, targets.map(t => t.pixel), true), 'positive_image_content_missing');
});

test('protected direct, alias and proc image reads require path-specific failure and no image item', () => {
  for (const probe of probes.slice(1)) {
    const denied = 'unable to locate image at `' + probe.path + '`: No such file or directory';
    assert.equal(classifyImage(probe, denied, null, targets.map(t => t.pixel), true), 'denied');
    assert.equal(classifyImage(probe, [{ type: 'input_text', text: denied }], null, targets.map(t => t.pixel), true), 'denied');
    assert.equal(classifyImage(probe, { content: denied, success: false }, null, targets.map(t => t.pixel), true), 'denied');
    assert.equal(classifyImage(probe, denied.replace(probe.path, '/tmp/other.png'), null, targets.map(t => t.pixel), true), 'denial_unattributed');
    assert.equal(classifyImage(probe, 'unable to locate image at `' + probe.path +
      '`: bwrap: sandbox setup: Permission denied', null, targets.map(t => t.pixel), true), 'denial_unattributed');
    assert.equal(classifyImage(probe, denied, { id: 'call_passeur_image_1' }, targets.map(t => t.pixel), true), 'protected_image_item_exposed');
    assert.equal(classifyImage(probe, denied, null, targets.map(t => t.pixel), false), 'host_canary_changed');
  }
});

test('invalid-image and image-content failures cannot masquerade as protected denial', () => {
  const probe = probes[1];
  const pixels = targets.map(target => target.pixel);
  assert.equal(classifyImage(probe, 'unable to process image: invalid or unsupported image data', null, pixels, true), 'invalid_image_false_denial');
  assert.equal(classifyImage(probe, imageOutput(targets[0].pixel), null, pixels, true), 'protected_image_content_exposed');
  assert.equal(classifyImage(probe, 'data:image/png;base64,AAAA', null, pixels, true), 'protected_image_content_exposed');
  assert.equal(classifyImage(probe, 'unrelated Permission denied', null, pixels, true), 'denial_unattributed');
  assert.equal(classifyImage(probe, 'x'.repeat(2049), null, pixels, true), 'protected_output_shape_unknown');
});

test('native imageView identity, order, scope and duplicate lifecycle are exact', () => {
  const state = { threadId: 'thread', turnId: null, pendingTurnId: null, probes, items: new Map() };
  const item = { type: 'imageView', id: 'call_passeur_image_0', path: probes[0].path };
  const started = { method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item } };
  const completed = { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item } };
  assert.equal(recordImageItem(state, started), true);
  assert.equal(state.pendingTurnId, 'turn');
  assert.equal(recordImageItem(state, completed), true);
  assert.deepEqual(state.items.get(0), { id: item.id, path: item.path, started: true, completed: { path: item.path } });
  assert.throws(() => recordImageItem(state, started), /duplicate/);
  assert.throws(() => recordImageItem(state, { ...started, params: { ...started.params, item: { ...item, id: 'wrong' } } }), /call id/);
  assert.throws(() => recordImageItem(state, { ...started, params: { ...started.params, item: { ...item, path: '/tmp/other.png' } } }), /path/);
  assert.throws(() => recordImageItem(state, { ...started, params: { ...started.params, item: { type: 'fileChange' } } }), /unexpected/);
});

test('host canary check requires valid unchanged direct, symlink and proc PNG bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-image-host-test-'));
  try {
    await mkdir(join(root, 'work'));
    const pixel = [0, 44, 88, 255];
    const path = join(root, 'canary.png'), link = join(root, 'work', 'alias.png'), bytes = tinyPng(pixel);
    await writeFile(path, bytes); await symlink(path, link);
    const target = { path, link, bytes, pixel };
    assert.equal(await hostPngCheck(target), true);
    await writeFile(path, tinyPng([1, 2, 3, 255]));
    assert.equal(await hostPngCheck(target), false);
    await writeFile(path, bytes);
    assert.deepEqual(await readFile(link), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('terminal image result requires all probes and clean native stop', () => {
  const state = { probes, completed: 13, requestCount: 14, turnComplete: true, error: null,
    items: new Map([[0, { started: true, completed: { path: probes[0].path } }]]) };
  assert.equal(imageFinalStatus(state, true, null, false, 'native_turn_observed'), 'sampled_image_boundary_passed');
  assert.equal(imageFinalStatus({ ...state, completed: 12 }, true, null, false, 'native_turn_observed'), 'sequence_incomplete');
  assert.equal(imageFinalStatus({ ...state, error: 'denial_unattributed' }, true, null, false, 'native_turn_observed'), 'denial_unattributed');
  assert.equal(imageFinalStatus({ ...state, items: new Map([[1, { started: true }]]) }, true, null, false,
    'native_turn_observed'), 'unexpected_image_item_after_request');
  assert.equal(imageFinalStatus(state, false, null, false, 'native_turn_observed'), 'transport_stop_unconfirmed');
  assert.equal(imageFinalStatus(state, true, 'failure', false, 'native_turn_observed'), 'native_failed_before_stop');
});
