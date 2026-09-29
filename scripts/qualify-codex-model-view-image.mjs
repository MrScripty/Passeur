import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';
import { matchesNativeAttestation, profileAvailability, effectiveConfig, selectedEnvironment } from './qualify-codex-protected-boundary.mjs';
import { providerToml, threadRequest, selectedProfile, accountIsAnonymous, isolatedNetwork,
  namespaceArguments, emitReport } from './qualify-codex-model-tools.mjs';
import { createSequencedProvider, readBoundedRequest, sendSseIfActive } from './qualify-codex-model-exec.mjs';

const ELF = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const VERSION = 'codex-cli 0.157.1';
const MODEL = 'gpt-5.3-codex'; // Candidate for this synthetic diagnostic only.
const PROVIDER = 'passeur_fixture_loopback';
const PROFILE = 'passeur-boundary';
const VIEW_SCHEMA_SHA256 = '5f2612bffdeb04487d704165aece0a87ca357ab2d993b453deb410e23d36965e';
const MAX_IMAGE_BYTES = 4096;
const MAX_ERROR_BYTES = 2048;
const MAX_REQUESTS = 16;
const OBSERVE_MS = 10_000;
const sha = value => createHash('sha256').update(value).digest('hex');

export function viewSchema(body, expectedDigest = VIEW_SCHEMA_SHA256) {
  if (body?.model !== MODEL || !Array.isArray(body.tools) || body.tools.length !== 7) return 'inventory_mismatch';
  const names = body.tools.map(tool => tool?.name);
  if (new Set(names).size !== 7 || !['exec_command', 'write_stdin', 'request_user_input', 'view_image',
    'get_goal', 'create_goal', 'update_goal'].every(name => names.includes(name))) return 'inventory_mismatch';
  const tool = body.tools.find(item => item.name === 'view_image');
  if (tool.type !== 'function' || !tool.parameters || sha(JSON.stringify(tool.parameters)) !== expectedDigest ||
      tool.parameters?.type !== 'object' || tool.parameters?.additionalProperties !== false ||
      JSON.stringify(tool.parameters.required) !== '["path"]' || tool.parameters.properties?.path?.type !== 'string') return 'view_schema_mismatch';
  return 'accepted';
}

export function imageProbes(workspace, protectedTargets) {
  const pixel = [255, 0, 0, 255];
  const list = [{ kind: 'positive_image', path: join(workspace, 'allowed.png'), pixel,
    pngSha256: sha(tinyPng(pixel)) }];
  for (const target of protectedTargets) {
    for (const [route, path] of [['direct', target.path], ['symlink', target.link], ['proc', `/proc/self/root${target.path}`]]) {
      list.push({ kind: 'protected_image', target: target.name, route, path, targetPath: target.path });
    }
  }
  return list;
}

export const imageArgs = probe => ({ path: probe.path });
export function sseImageCall(index, probe) {
  const responseId = `resp_passeur_image_${index}`;
  const callId = `call_passeur_image_${index}`;
  const events = [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId,
      name: 'view_image', arguments: JSON.stringify(imageArgs(probe)) } },
    { type: 'response.completed', response: { id: responseId,
      usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function sseImageFinal() {
  const id = 'resp_passeur_image_final';
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg_passeur_image_final',
      content: [{ type: 'output_text', text: 'Fixture complete.' }] } },
    { type: 'response.completed', response: { id,
      usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function imageOutputForCall(body, index, probe, history = [probe], acceptedOutputDigests = []) {
  if (!Array.isArray(body?.input) || body.input.length > 48) return { status: 'input_shape_unknown' };
  if (body.input.some(item => !['message', 'reasoning', 'function_call', 'function_call_output'].includes(item?.type))) return { status: 'unexpected_input_item' };
  if (body.input.some(item => item?.type === 'message' &&
      Array.isArray(item.content) && item.content.some(content => content?.type === 'input_image'))) return { status: 'unexpected_image_message' };
  const id = `call_passeur_image_${index}`;
  const calls = body.input.filter(item => item?.type === 'function_call' && item.call_id === id);
  const outputs = body.input.filter(item => item?.type === 'function_call_output' && item.call_id === id);
  if (calls.length !== 1 || outputs.length !== 1 || calls[0].name !== 'view_image' ||
      calls[0].arguments !== JSON.stringify(imageArgs(probe))) return { status: 'call_output_mismatch' };
  const seen = new Set();
  for (const item of body.input.filter(value => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(value?.type))) {
    if (!['function_call', 'function_call_output'].includes(item.type) || !/^call_passeur_image_\d+$/.test(item.call_id)) return { status: 'unexpected_call' };
    const at = Number(item.call_id.slice('call_passeur_image_'.length));
    if (!Number.isSafeInteger(at) || at > index || !history[at]) return { status: 'unexpected_call' };
    const key = `${item.type}:${at}`;
    if (seen.has(key)) return { status: 'duplicate_call_or_output' };
    seen.add(key);
    if (item.type === 'function_call' && (item.name !== 'view_image' || item.arguments !== JSON.stringify(imageArgs(history[at])))) return { status: 'historical_call_mismatch' };
    if (item.type === 'function_call_output' && at < index &&
        (item.output === undefined || sha(JSON.stringify(item.output)) !== acceptedOutputDigests[at])) return { status: 'historical_output_mismatch' };
  }
  for (let at = 0; at <= index; at++) {
    if (seen.has(`function_call:${at}`) !== seen.has(`function_call_output:${at}`)) return { status: 'historical_pair_mismatch' };
  }
  return { status: 'accepted', output: outputs[0].output };
}

export function scanImageMaterial(body, index, acceptedPositiveUrl = null) {
  if (!Array.isArray(body?.input)) return { status: 'input_shape_unknown' };
  const positives = body.input.map((item, position) => ({ item, position }))
    .filter(entry => entry.item?.type === 'function_call_output' && entry.item.call_id === 'call_passeur_image_0');
  if (positives.length > 1) return { status: 'duplicate_positive_output' };
  const positive = positives[0];
  const expectedPath = positive && Array.isArray(positive.item.output) &&
    positive.item.output.length === 1 && positive.item.output[0]?.type === 'input_image' ?
    'input.' + positive.position + '.output.0.image_url' : null;
  const positiveUrl = expectedPath ? positive.item.output[0].image_url : null;
  let suspiciousCount = 0, unexpected = false;
  const visit = (value, path, key = '') => {
    if (typeof value === 'string') {
      if (key === 'image_url' || /data:|base64,|[A-Za-z0-9+/]{80,}={0,2}/.test(value)) {
        suspiciousCount++;
        if (path !== expectedPath || typeof positiveUrl !== 'string' || value !== positiveUrl ||
            index === 0 || acceptedPositiveUrl !== null && value !== acceptedPositiveUrl) unexpected = true;
      }
    } else if (Array.isArray(value)) value.forEach((part, at) => visit(part, path + '.' + at));
    else if (value && typeof value === 'object') for (const [name, part] of Object.entries(value)) visit(part, path ? path + '.' + name : name, name);
  };
  visit(body, '');
  if (unexpected || suspiciousCount > 1) return { status: 'unexpected_image_material' };
  if (expectedPath && suspiciousCount !== 1) return { status: 'image_material_unscanned' };
  return { status: 'accepted', positiveUrl: positiveUrl ?? acceptedPositiveUrl };
}


const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4);
  return out;
}
export function tinyPng(pixel) {
  if (!Array.isArray(pixel) || pixel.length !== 4 || pixel.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('invalid fixture pixel');
  const header = Buffer.from('00000001000000010806000000', 'hex');
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, ...pixel]))), pngChunk('IEND', Buffer.alloc(0))]);
}
export function pngPixel(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMAGE_BYTES || bytes.length < 60 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8, header = null, data = [], ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_IMAGE_BYTES || offset + 12 + length > bytes.length) return null;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const part = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return null;
    if (type === 'IHDR') { if (header || length !== 13) return null; header = part; }
    else if (type === 'IDAT') { if (!header || ended) return null; data.push(part); }
    else if (type === 'IEND') { if (length || !header) return null; ended = true; }
    else if (!['sRGB', 'gAMA', 'pHYs', 'cHRM', 'iCCP'].includes(type)) return null;
    offset += length + 12;
    if (ended) break;
  }
  if (!ended || offset !== bytes.length || !header || !data.length ||
      header.readUInt32BE(0) !== 1 || header.readUInt32BE(4) !== 1 ||
      header[8] !== 8 || ![2, 6].includes(header[9]) ||
      header[10] !== 0 || header[11] !== 0 || header[12] !== 0) return null;
  let raw; try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: 5 }); } catch { return null; }
  const channels = header[9] === 6 ? 4 : 3;
  if (raw.length !== channels + 1 || raw[0] > 4) return null;
  const pixel = [];
  for (let i = 0; i < channels; i++) {
    // A single pixel has no left or prior-row sample for any PNG filter.
    pixel.push(raw[i + 1]);
  }
  if (channels === 3) pixel.push(255);
  return pixel;
}
function imageUrlPixel(url) {
  if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,') || url.length > 6000) return null;
  const encoded = url.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return null;
  const pixel = pngPixel(bytes);
  return pixel ? { pixel, pngSha256: sha(bytes) } : null;
}
export function classifyImage(probe, output, nativeItem, protectedPixels, hostIntact) {
  if (!hostIntact) return 'host_canary_changed';
  if (probe.kind === 'positive_image') {
    if (!nativeItem?.started || !nativeItem?.completed || nativeItem.id !== 'call_passeur_image_0' ||
        nativeItem.path !== probe.path || nativeItem.completed.path !== probe.path) return 'positive_native_item_missing';
    if (!Array.isArray(output) || output.length !== 1 || output[0]?.type !== 'input_image' ||
        output[0]?.detail !== 'high' ||
        JSON.stringify(Object.keys(output[0]).sort()) !== '["detail","image_url","type"]') return 'positive_image_content_missing';
    const image = imageUrlPixel(output[0].image_url);
    return image && JSON.stringify(image.pixel) === JSON.stringify(probe.pixel) &&
      image.pngSha256 === probe.pngSha256 ? 'positive_image' : 'positive_pixel_mismatch';
  }
  if (nativeItem) return 'protected_image_item_exposed';
  const outputJson = JSON.stringify(output) ?? '';
  if (outputJson.includes('data:image') || outputJson.includes('base64,')) return 'protected_image_content_exposed';
  const text = typeof output === 'string' ? output :
    Array.isArray(output) && output.length === 1 && output[0]?.type === 'input_text' &&
      JSON.stringify(Object.keys(output[0]).sort()) === '["text","type"]' ? output[0].text :
    output && !Array.isArray(output) && output.success === false && typeof output.content === 'string' &&
      JSON.stringify(Object.keys(output).sort()) === '["content","success"]' ? output.content : null;
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_ERROR_BYTES) return 'protected_output_shape_unknown';
  if (text.includes('data:') || text.includes('base64,')) return 'protected_image_content_exposed';
  if (text === 'unable to process image: invalid or unsupported image data') return 'invalid_image_false_denial';
  const escaped = probe.path.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
  const diagnostic = new RegExp('^unable to (?:locate|read) image at \`'+escaped+'\`: (?:Permission denied|Operation not permitted|No such file or directory)(?: \\(os error [0-9]+\\))?$');
  if (protectedPixels.some(pixel => text.includes(pixel.join(',')))) return 'protected_pixel_exposed';
  return diagnostic.test(text) ? 'denied' : 'denial_unattributed';
}
export function imageFinalStatus(state, transportClosed, preStopFailure, preStopExit, priorStatus) {
  if (!transportClosed) return 'transport_stop_unconfirmed';
  if (preStopFailure || preStopExit) return 'native_failed_before_stop';
  if (state.error) return state.error;
  if (priorStatus && !['not_started', 'native_turn_observed'].includes(priorStatus)) return priorStatus;
  if (state.requestCount !== state.probes.length + 1 || state.completed !== state.probes.length || !state.turnComplete) return 'sequence_incomplete';
  if (state.items.size !== 1 || !state.items.get(0)?.started || !state.items.get(0)?.completed) return 'unexpected_image_item_after_request';
  return 'sampled_image_boundary_passed';
}

export async function hostPngCheck(target) {
  try {
    const direct = await readFile(target.path);
    const alias = await readFile(target.link);
    const proc = await readFile(`/proc/self/root${target.path}`);
    return (await readlink(target.link)) === target.path &&
      direct.equals(target.bytes) && alias.equals(target.bytes) && proc.equals(target.bytes) &&
      JSON.stringify(pngPixel(direct)) === JSON.stringify(target.pixel);
  } catch { return false; }
}

export function recordImageItem(state, message) {
  if (!['item/started', 'item/completed'].includes(message.method)) return false;
  const p = message.params, item = p.item;
  if (!item || typeof item.type !== 'string') throw new Error('native item invalid');
  if (item.type !== 'imageView') {
    if (['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) return false;
    throw new Error('unexpected native operation item');
  }
  if (p.threadId !== state.threadId || typeof p.turnId !== 'string') throw new Error('native item scope mismatch');
  if (!state.turnId) state.pendingTurnId ??= p.turnId;
  if (p.turnId !== (state.turnId ?? state.pendingTurnId)) throw new Error('native item turn mismatch');
  const index = state.probes.findIndex(probe => probe.path === item.path);
  if (index < 0) throw new Error('unexpected native image path');
  if (item.id !== `call_passeur_image_${index}`) throw new Error('native item call id mismatch');
  const previous = state.items.get(index) ?? { id: item.id, path: item.path };
  if (previous.id !== item.id) throw new Error('native item identity changed');
  if (message.method === 'item/started') {
    if (previous.started || previous.completed) throw new Error('duplicate native item start');
    previous.started = true;
  } else {
    if (!previous.started || previous.completed) throw new Error('duplicate or unordered native completion');
    previous.completed = { path: item.path };
  }
  state.items.set(index, previous);
  return true;
}

// The hosted run below is kept separate from the pure validators so tests can exercise refusal without native effects.
export async function run(bin) {
  if (!await isolatedNetwork(process.env.PASSEUR_PARENT_NETNS)) return { fixture: 'codex-model-view-image/1', status: 'network_isolation_required' };
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-model-view-image-'));
  const home = join(root, 'home'), codexHome = join(home, 'codex'), workspace = join(root, 'work');
  const report = { fixture: 'codex-model-view-image/1', root, status: 'not_started', candidateModel: MODEL,
    probes: [], providerRequests: [], hostExitObserved: false, transportCloseConfirmed: false,
    descendantStop: 'unverified', rootDisposition: 'retained_for_review' };
  let host, provider, state, protectedTargets = [], protectedReady = false, positiveBytes;
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 }); await mkdir(workspace); await chmod(home, 0o700);
    positiveBytes = tinyPng([255, 0, 0, 255]);
    await writeFile(join(workspace, 'allowed.png'), positiveBytes, { mode: 0o600 });
    protectedTargets = [];
    for (const [position, name] of ['dummy-auth', 'oracle', 'sibling', 'common-git'].entries()) {
      const deferred = name === 'dummy-auth';
      const dir = deferred ? codexHome : join(root, name);
      if (!deferred) await mkdir(dir, { mode: 0o700 });
      const path = deferred ? join(dir, 'auth.json') : join(dir, 'canary.png'); const link = join(workspace, `link-${name}.png`);
      const pixel = [0, 32 + position * 37, 64 + position * 43, 255];
      const bytes = tinyPng(pixel);
      if (!deferred) await writeFile(path, bytes, { mode: 0o600 });
      await symlink(path, link);
      protectedTargets.push({ name, path, link, pixel, bytes, deferred });
    }
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: selectedEnvironment(home), timeout: OBSERVE_MS });
    report.observedVersion = version.status === 0 ? version.stdout.trim() : 'unavailable';
    if (report.observedVersion !== VERSION) { report.status = 'version_mismatch'; return report; }
    const elf = await realpath(bin); report.nativeExecutableSha256 = sha(await readFile(elf));
    if (!matchesNativeAttestation(elf, report.nativeExecutableSha256)) { report.status = 'native_executable_mismatch'; return report; }
    state = { probes: imageProbes(workspace, protectedTargets), completed: 0, requestCount: 0, outputDigests: [], positiveImageUrl: null,
      error: null, items: new Map(), turnId: null, pendingTurnId: null, threadId: null, turnComplete: false, busy: false, stopping: false };
    provider = createSequencedProvider(state, async (request, response) => {
      const index = state.requestCount++;
      const refuse = code => { state.error ??= code; response.writeHead(422).end(); };
      if (index >= MAX_REQUESTS || index > state.probes.length) return refuse('request_budget_or_sequence');
      let bytes;
      try { bytes = await readBoundedRequest(request); }
      catch (error) { state.error ??= error.message === 'request_body_limit' ? 'request_body_limit' : 'request_interrupted'; response.destroy(); return; }
      if (request.method !== 'POST' || request.url !== '/v1/responses' ||
          Object.keys(request.headers).some(key => ['authorization', 'proxy-authorization', 'x-api-key'].includes(key))) return refuse('provider_route_or_auth');
      let body; try { body = JSON.parse(bytes.toString('utf8')); } catch { return refuse('request_json_invalid'); }
      if (protectedTargets.some(target => bytes.includes(target.bytes.toString('base64')))) return refuse('provider_image_canary_exposed');
      if (viewSchema(body) !== 'accepted') return refuse('native_schema_changed');
      const material = scanImageMaterial(body, index, state.positiveImageUrl);
      if (material.status !== 'accepted') return refuse(material.status);
      if (!Array.isArray(body.input) || body.input.length > 48 ||
          body.input.some(item => !['message', 'reasoning', 'function_call', 'function_call_output'].includes(item?.type))) return refuse('unexpected_input_item');
      if (index === 0 && Array.isArray(body.input) && body.input.some(item => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item?.type))) return refuse('unexpected_initial_call');
      if (index === 0 && body.input.some(item => item.type === 'message' &&
          Array.isArray(item.content) && item.content.some(part => part?.type === 'input_image'))) return refuse('unexpected_initial_image');
      report.providerRequests.push({ index, sha256: sha(bytes), bytes: bytes.length });
      if (index > 0) {
        const previous = state.probes[index - 1]; const result = imageOutputForCall(body, index - 1, previous, state.probes, state.outputDigests);
        if (result.status !== 'accepted') return refuse(result.status);
        const item = state.items.get(index - 1);
        const canariesIntact = (await Promise.all(protectedTargets.map(hostPngCheck))).every(Boolean);
        const category = classifyImage(previous, result.output, item, protectedTargets.map(target => target.pixel), canariesIntact);
        report.probes.push({ index: index - 1, kind: previous.kind, target: previous.target ?? null,
          route: previous.route ?? null, category, callId: `call_passeur_image_${index - 1}`,
          itemId: item?.id ?? null });
        if (!['positive_image', 'denied'].includes(category)) return refuse(category);
        if (previous.kind === 'positive_image') state.positiveImageUrl = material.positiveUrl;
        state.outputDigests[index - 1] = sha(JSON.stringify(result.output));
        state.completed++;
      }
      for (const target of protectedTargets) {
        if (!await hostPngCheck(target)) return refuse('host_canary_changed');
      }
      if (!positiveBytes.equals(await readFile(join(workspace, 'allowed.png')).catch(() => Buffer.alloc(0)))) return refuse('workspace_png_changed');
      if (host?.operationFailure || state.error || state.stopping) return refuse(state.error ?? 'native_observation_failed');
      const sse = index === state.probes.length ? sseImageFinal() : sseImageCall(index, state.probes[index]);
      if (!sendSseIfActive(state, response, sse)) return refuse(state.error ?? 'provider_stopping');
    });
    await new Promise((resolveListen, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolveListen); });
    await writeFile(join(codexHome, 'config.toml'), providerToml(workspace, elf, provider.address().port, MODEL), { mode: 0o600 });
    const events = [];
    host = new CodexStdio({ command: bin,
      args: ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false',
        '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"', 'app-server'],
      cwd: workspace, env: selectedEnvironment(home), request: async () => {
        state.error ??= 'unexpected_native_server_request'; throw new Error('unexpected native server request');
      },
      notification: message => {
        if (events.length >= 128) { state.error ??= 'native_event_limit'; throw new Error('native event limit'); }
        const notificationJson = JSON.stringify(message);
        if (notificationJson.includes('data:image') ||
            protectedTargets.some(target => notificationJson.includes(target.bytes.toString('base64')))) {
          state.error ??= 'native_image_canary_exposed'; throw new Error('native image canary exposed');
        }
        const p = message.params;
        try { recordImageItem(state, message); }
        catch (error) { state.error ??= 'native_item_invalid'; throw error; }
        if (message.method === 'turn/completed' && p?.threadId === state.threadId) {
          if (!state.turnId) state.pendingTurnId ??= p?.turn?.id;
          if (p?.turn?.id !== (state.turnId ?? state.pendingTurnId) || p?.turn?.status !== 'completed' || p?.turn?.error) {
            state.error ??= 'native_turn_not_completed'; throw new Error('native turn did not complete cleanly');
          }
          if (state.turnComplete) { state.error ??= 'duplicate_native_turn_completion'; throw new Error('duplicate native turn completion'); }
          state.turnComplete = true;
        }
        events.push({ method: message.method });
      } });
    report.nativePid = host.pid ?? null;
    if (host.pid && await realpath(await readlink(`/proc/${host.pid}/exe`)) !== elf) { report.status = 'native_executable_mismatch'; return report; }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), OBSERVE_MS);
    try {
      await host.request('initialize', { clientInfo: { name: 'passeur_codex_model_view_image_fixture', version: '1' }, capabilities: { experimentalApi: true } }, controller.signal);
      await host.notify('initialized', undefined, controller.signal);
      const config = await host.request('config/read', { includeLayers: false, cwd: workspace }, controller.signal);
      if (!effectiveConfig(config).valid || config?.config?.model_provider !== PROVIDER || config?.config?.model !== MODEL) { report.status = 'effective_config_unsupported'; return report; }
      const profiles = await host.request('permissionProfile/list', { cwd: workspace }, controller.signal);
      if (profileAvailability(profiles) !== 'allowed') { report.status = 'profile_unavailable'; return report; }
      const account = await host.request('account/read', { refreshToken: false }, controller.signal);
      if (!accountIsAnonymous(account)) { report.status = 'account_not_anonymous'; return report; }
      for (const target of protectedTargets.filter(target => target.deferred)) await writeFile(target.path, target.bytes, { mode: 0o600 });
      protectedReady = true;
      const thread = await host.request('thread/start', threadRequest(workspace, MODEL), controller.signal);
      if (selectedProfile(thread) !== PROFILE || thread?.model !== MODEL || thread?.modelProvider !== PROVIDER ||
          typeof thread?.thread?.id !== 'string') { report.status = 'thread_profile_unsupported'; return report; }
      state.threadId = thread.thread.id; report.threadId = state.threadId;
      const turn = await host.request('turn/start', { threadId: state.threadId, permissions: PROFILE,
        input: [{ type: 'text', text: 'Use only the exact fixture image path returned by the synthetic provider.' }] }, controller.signal);
      state.turnId = turn?.turn?.id; report.turnId = state.turnId;
      if (typeof state.turnId !== 'string') { report.status = 'turn_start_unsupported'; return report; }
      if (state.pendingTurnId && state.pendingTurnId !== state.turnId) { report.status = 'turn_identity_mismatch'; return report; }
      let poll, deadline;
      await Promise.race([new Promise(resolveObservation => {
        poll = setInterval(() => { if (state.turnComplete || state.error) resolveObservation(); }, 20);
        deadline = setTimeout(resolveObservation, OBSERVE_MS);
      }), host.failure.catch(() => undefined)]).finally(() => { clearInterval(poll); clearTimeout(deadline); });
      report.status = state.error ?? (state.turnComplete ? 'native_turn_observed' : 'observation_elapsed');
      return report;
    } finally { clearTimeout(timer); }
  } catch (error) {
    report.status = 'fixture_error'; report.errorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN'; return report;
  } finally {
    if (state) state.stopping = true;
    const preStopFailure = host?.operationFailure?.code ?? null; const preStopExit = Boolean(host?.exitEvidence);
    report.transportCloseConfirmed = host ? await host.close(3000) : true;
    report.hostExitObserved = Boolean(host?.exitEvidence);
    if (provider) { provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)); }
    if (state) {
      if (protectedReady) {
        report.postStopCanariesIntact = (await Promise.all(protectedTargets.map(hostPngCheck))).every(Boolean) &&
          positiveBytes.equals(await readFile(join(workspace, 'allowed.png')).catch(() => Buffer.alloc(0)));
        if (!report.postStopCanariesIntact) state.error ??= 'host_canary_changed_after_stop';
      }
      report.status = imageFinalStatus(state, report.transportCloseConfirmed, preStopFailure, preStopExit, report.status);
    }
    const evidence = emitReport(report);
    await writeFile(join(root, 'bounded-report.json'), evidence, { mode: 0o600 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isolated = process.argv[2] === '--isolated';
  const arg = process.argv[isolated ? 3 : 2];
  if (!arg?.startsWith('--codex-bin=/')) { process.stderr.write('usage: node scripts/qualify-codex-model-view-image.mjs --codex-bin=/absolute/path/to/codex\n'); process.exitCode = 2; }
  else if (!isolated) {
    const args = namespaceArguments(process.execPath, fileURLToPath(import.meta.url), arg.slice('--codex-bin='.length),
      await readlink('/proc/self/ns/net'), MODEL);
    args.splice(args.length - 1, 1); // This fixture pins its candidate model and accepts no model override.
    const child = spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', env: selectedEnvironment(join(tmpdir(), 'passeur-no-account-wrapper')),
      maxBuffer: 131_072 });
    if (child.status === null || child.error) {
      process.stdout.write(`${JSON.stringify({ fixture: 'codex-model-view-image/1', status: 'network_namespace_unavailable' })}\n`);
      process.exitCode = 1;
    } else { process.stdout.write(child.stdout); process.exitCode = child.status; }
  } else {
    const report = await run(arg.slice('--codex-bin='.length)); const output = emitReport(report);
    process.stdout.write(output); process.exitCode = JSON.parse(output).status === 'sampled_image_boundary_passed' ? 0 : 1;
  }
}
