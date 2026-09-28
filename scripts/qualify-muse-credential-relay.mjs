#!/usr/bin/env node
// Disposable synthetic-credential boundary; installed mode is explicit and uses no real account.
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile, chmod, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { prepareSandbox, probeBubblewrap } from './experiment-worker-sandbox.mjs';
import { pinnedNode, tcpProbe, classifyNoRoute, loopbackReady, parseBubblewrapStatus,
  startShellProvider, stageRuntime, startHostSentinel, runStatusPhase,
  captureHostIdentities, verifyHostStop, validateShellReady, validateReadFileOutcome,
  readFileCanaryFixture, shellProbeCommand } from './qualify-muse-sandbox-transport.mjs';
import { spawnSync } from 'node:child_process';

const DUMMY = 'passeur-disposable-dummy-key';
const MODEL = 'fixture-relay-model';
const NATIVE_MODEL = 'fixture-native-shell';
const NATIVE_REQUEST_LIMIT = 262_144;
const NATIVE_AGGREGATE_REQUEST_LIMIT = NATIVE_REQUEST_LIMIT * 5;
const NATIVE_CAPTURE_ARTIFACT_LIMIT = 4_096;
const NATIVE_DIAGNOSTIC_SCHEMA_NODE_LIMIT = 8_192;
// Field names only. This vocabulary changes capture evidence, never request admission.
const NATIVE_TOP_LEVEL_CAPTURE_FIELDS = Object.freeze([
  'background', 'conversation', 'include', 'instructions', 'max_output_tokens',
  'max_tool_calls', 'metadata', 'parallel_tool_calls', 'prompt', 'prompt_cache_key',
  'prompt_cache_retention', 'reasoning', 'safety_identifier', 'service_tier',
  'store', 'stream', 'stream_options', 'temperature', 'text', 'tool_choice',
  'top_logprobs', 'top_p', 'truncation', 'user',
]);
const NATIVE_REASONING_CAPTURE_FIELDS = Object.freeze(['effort', 'summary', 'generate_summary']);
const NATIVE_SCHEMA_KEYS = new Set(['type', 'description', 'title', 'examples', 'properties',
  'required', 'additionalProperties', 'items', 'enum', 'const', 'nullable',
  'anyOf', 'oneOf', 'allOf', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems',
  'maxItems', 'minProperties', 'maxProperties']);
const NATIVE_SCHEMA_TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const NATIVE_RESPONSE_IDS = new Set(['resp_native_read_file_1', 'resp_native_read_file_2',
  'resp_native_reminder_1', 'resp_native_reminder_2', 'resp_native_verify_reminder_1']);
const NATIVE_ITEM_IDS = new Set(['fc_native_read_file_1', 'fc_native_reminder_1',
  'fc_native_reminder_2', 'fc_native_verify_reminder_1']);
const NATIVE_CALL_IDS = new Set(['call_native_read_file_1', 'call_native_reminder_1',
  'call_native_reminder_2', 'call_native_verify_reminder_1']);
const NATIVE_EVENT_TYPES = new Set(['response.created', 'response.completed',
  'response.content_part.added', 'response.content_part.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.output_item.added', 'response.output_item.done',
  'response.output_text.delta', 'response.output_text.done']);
const GUEST_RUNTIME = '/mounts/runtime';
const GUEST_SOCKET = '/mounts/relay/relay.sock';
const REQUEST_LIMIT = 8_192;
const RESPONSE_LIMIT = 65_536;
const OUTPUT_LIMIT = 16_384;
const RUN_MS = 20_000;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function boundedCode(error) {
  const code = error?.code ?? error?.name;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ?
    code : 'UNCLASSIFIED_ERROR';
}
async function settleWithin(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fault(code, `phase exceeded ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
function send(response, status, code) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code } }));
}
function awaitListen(server, target) {
  return new Promise((resolveValue, reject) => {
    server.once('error', reject);
    server.listen(target, () => { server.off('error', reject); resolveValue(server.address()); });
  });
}
function nativeInputAllowed(input) {
  if (typeof input === 'string') return input.length > 0 && Buffer.byteLength(input) <= 32_768 &&
    (input.includes('NATIVE_READ_FILE_PROBE') || input.includes('NATIVE_READ_FILE_SCHEMA_PROBE'));
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) return false;
  const keys = {
    message: ['type', 'role', 'content', 'id'],
    function_call: ['type', 'id', 'call_id', 'name', 'arguments'],
    function_call_output: ['type', 'call_id', 'output'],
    reasoning: ['type', 'id', 'summary'],
  };
  return input.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !keys[item.type] ||
        Object.keys(item).some(key => !keys[item.type].includes(key))) return false;
    if (item.id !== undefined && !NATIVE_ITEM_IDS.has(item.id) &&
        !['msg_native_read_file_2'].includes(item.id)) return false;
    if (item.call_id !== undefined && !NATIVE_CALL_IDS.has(item.call_id)) return false;
    if (item.type === 'function_call_output' && typeof item.output !== 'string') return false;
    if (item.type === 'function_call_output' && Buffer.byteLength(item.output) > 8_192) return false;
    if (item.type === 'function_call' && (item.name !== 'muse.read_file' &&
        item.name !== 'muse.submit_reminder_decision' || typeof item.arguments !== 'string')) return false;
    if (item.type === 'function_call' && Buffer.byteLength(item.arguments) > 4_096) return false;
    if (item.type === 'message' && (typeof item.content !== 'string' ||
        Buffer.byteLength(item.content) > 32_768 ||
        item.role !== undefined && !['developer', 'user', 'assistant'].includes(item.role))) return false;
    if (item.type === 'reasoning' &&
        (typeof item.summary !== 'string' || Buffer.byteLength(item.summary) > 4_096)) return false;
    return true;
  });
}
function nativeToolsFailure(tools) {
  const failure = (code, functionIndex = null) => ({ code, functionIndex });
  if (!Array.isArray(tools) || tools.length !== 1) return failure('NAMESPACE_COUNT');
  const namespace = tools[0];
  if (!namespace || namespace.type !== 'namespace' || namespace.name !== 'muse' ||
      Object.keys(namespace).some(key => !['type', 'name', 'description', 'tools'].includes(key)) ||
      namespace.description !== undefined && (typeof namespace.description !== 'string' ||
        Buffer.byteLength(namespace.description) > 2_048) ||
      !Array.isArray(namespace.tools) || ![1, 25].includes(namespace.tools.length))
    return failure('NAMESPACE_SHAPE');
  const names = namespace.tools.map(tool => tool?.name);
  if (new Set(names).size !== names.length ||
      (names.length === 25 && names[1] !== 'read_file') ||
      (names.length === 1 && names[0] !== 'submit_reminder_decision'))
    return failure('FUNCTION_NAME_SET');
  const schemaKeys = NATIVE_SCHEMA_KEYS;
  const schemaTypes = NATIVE_SCHEMA_TYPES;
  const context = { nodes: 0 };
  const schemaFailure = (schema, depth = 0, functionIndex) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'SCHEMA_SHAPE';
    if (depth > 8 || ++context.nodes > 512) return 'SCHEMA_COMPLEXITY';
    if (Object.keys(schema).some(key => !schemaKeys.has(key))) return 'SCHEMA_KEYS';
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties') {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length > 64) return 'SCHEMA_PROPERTIES';
        for (const child of Object.values(value)) {
          const issue = schemaFailure(child, depth + 1, functionIndex);
          if (issue) return issue;
        }
      } else if (key === 'items' || key === 'additionalProperties' &&
          typeof value === 'object') {
        const issue = schemaFailure(value, depth + 1, functionIndex);
        if (issue) return issue;
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
        if (!Array.isArray(value) || value.length < 1 || value.length > 8)
          return 'SCHEMA_COMPOSITION';
        for (const child of value) {
          const issue = schemaFailure(child, depth + 1, functionIndex);
          if (issue) return typeof issue === 'object' ? issue : 'SCHEMA_COMPOSITION';
        }
      } else if (key === 'required') {
        if (!Array.isArray(value) || value.length > 64 ||
            value.some(item => typeof item !== 'string' || item.length > 64) ||
            new Set(value).size !== value.length) return 'SCHEMA_REQUIRED';
      } else if (key === 'type') {
        const values = Array.isArray(value) ? value : [value];
        const expandedUnion = namespace.tools.length === 25 && functionIndex === 0 &&
          depth === 1 && Array.isArray(value);
        if (!values.length || values.length > (expandedUnion ? 6 : 3) ||
            values.some(item => !schemaTypes.includes(item)) ||
            expandedUnion && new Set(values).size !== values.length) {
          const memberLimit = 64;
          return { code: 'SCHEMA_TYPE', schemaType: {
            depth, class: Array.isArray(value) ? 'array' : 'scalar',
            memberCount: Math.min(values.length, memberLimit),
            moreMembers: values.length > memberLimit,
            recognizedTypes: schemaTypes.filter(label => values.includes(label)),
            unknownMemberCount: Math.min(values.reduce((count, item) =>
              count + Number(!schemaTypes.includes(item)), 0), memberLimit),
          } };
        }
      } else if (key === 'enum' || key === 'examples') {
        if (!Array.isArray(value) || value.length > 16 ||
            value.some(item => item !== null &&
              (!['string', 'number', 'boolean'].includes(typeof item) ||
                typeof item === 'string' && Buffer.byteLength(item) > 2_048)))
          return 'SCHEMA_ENUM';
      } else if (['description', 'title'].includes(key)) {
        const expandedDescription = key === 'description' && namespace.tools.length === 25 &&
          functionIndex === 0 && depth === 1;
        if (typeof value !== 'string' ||
            Buffer.byteLength(value) > (expandedDescription ? 8_192 : 2_048) ||
            expandedDescription && Buffer.from(value, 'utf8').toString('utf8') !== value)
          return { code: 'SCHEMA_DESCRIPTION', schemaDescription: {
            depth, class: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
            ...(typeof value === 'string' ? { byteCount: Buffer.byteLength(value) } : {}),
          } };
      } else if (key === 'nullable' || key === 'additionalProperties') {
        if (typeof value !== 'boolean') return 'SCHEMA_BOOLEAN';
      } else if (key === 'const') {
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value) ||
            typeof value === 'string' && Buffer.byteLength(value) > 2_048)
          return 'SCHEMA_CONST';
      } else if (typeof value !== 'number' ||
          !Number.isFinite(value) || Math.abs(value) > 1_000_000) return 'SCHEMA_NUMBER';
    }
    return null;
  };
  for (const [index, tool] of namespace.tools.entries()) {
    if (tool?.type !== 'function') return failure('FUNCTION_TYPE', index);
    if (typeof tool.name !== 'string' || !/^[a-z_][a-z0-9_]{0,63}$/.test(tool.name))
      return failure('FUNCTION_NAME_SYNTAX', index);
    if (Object.keys(tool).some(key =>
      !['type', 'name', 'description', 'parameters', 'strict'].includes(key)))
      return failure('FUNCTION_FIELDS', index);
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean')
      return failure('FUNCTION_STRICT', index);
    const descriptionLimit = namespace.tools.length === 25 && index === 0 ? 8_192 : 2_048;
    if (tool.description !== undefined && (typeof tool.description !== 'string' ||
        Buffer.byteLength(tool.description) > descriptionLimit ||
        Buffer.from(tool.description, 'utf8').toString('utf8') !== tool.description))
      return { ...failure('FUNCTION_DESCRIPTION', index),
        descriptionType: tool.description === null ? 'null' :
          Array.isArray(tool.description) ? 'array' : typeof tool.description,
        descriptionBytes: typeof tool.description === 'string' ?
          Buffer.byteLength(tool.description) : null };
    const issue = schemaFailure(tool.parameters, 0, index);
    if (issue) return typeof issue === 'object' ?
      { ...failure(issue.code, index), ...(issue.schemaType ? { schemaType: issue.schemaType } :
        { schemaDescription: issue.schemaDescription }) } : failure(issue, index);
  }
  return null;
}
function nativeToolsAllowed(tools) { return nativeToolsFailure(tools) === null; }
export function validateNativeSse(bytes) {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n\n') || Buffer.from(text).length !== bytes.length) {
    throw fault('NATIVE_STREAM_INVALID', 'native response stream was truncated or invalid UTF-8');
  }
  const frames = text.slice(0, -2).split('\n\n');
  if (frames.length < 2 || frames.length > 32) {
    throw fault('NATIVE_STREAM_INVALID', 'native response event count invalid');
  }
  let previous = 0;
  for (const [index, frame] of frames.entries()) {
    if (!frame.startsWith('data: ') || frame.includes('\n')) {
      throw fault('NATIVE_STREAM_INVALID', 'native event framing invalid');
    }
    let event;
    try { event = JSON.parse(frame.slice(6)); }
    catch { throw fault('NATIVE_STREAM_INVALID', 'native event JSON invalid'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        !NATIVE_EVENT_TYPES.has(event.type) ||
        !Number.isSafeInteger(event.sequence_number) || event.sequence_number !== previous + 1 ||
        (index === 0) !== (event.type === 'response.created') ||
        (index === frames.length - 1) !== (event.type === 'response.completed') ||
        event.type === 'response.completed' && event.response?.status !== 'completed') {
      throw fault('NATIVE_STREAM_INVALID', 'native event sequence or terminal invalid');
    }
    previous = event.sequence_number;
  }
  return { events: frames.length };
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolveValue, reject) => server.close(error => error ? reject(error) : resolveValue()));
}

export function requestDecision(request, body, policy) {
  const raw = request.rawHeaders ?? [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    if (seen.has(name)) return { ok: false, code: 'DUPLICATE_HEADER' };
    seen.add(name);
  }
  const allowed = new Set(['host', 'authorization', 'accept', 'content-type', 'content-length',
    'connection', 'transfer-encoding', 'x-passeur-run']);
  if (Object.keys(request.headers ?? {}).some(name => !allowed.has(name))) {
    return { ok: false, code: 'HEADER_REJECTED' };
  }
  const headers = request.headers ?? {};
  if (headers['x-passeur-run'] !== policy.runId ||
      headers.authorization !== `Bearer ${DUMMY}` ||
      headers.connection && !['close', 'keep-alive'].includes(headers.connection) ||
      headers['transfer-encoding'] && headers['transfer-encoding'] !== 'chunked' ||
      headers.host && !/^127\.0\.0\.1:\d+$/.test(headers.host)) {
    return { ok: false, code: 'RUN_OR_HEADER_REJECTED' };
  }
  if (request.method === 'GET' && request.url === '/muse-code/models' && body.length === 0) {
    return { ok: true, route: 'catalog', body: Buffer.alloc(0) };
  }
  if (request.method === 'POST' && request.url === '/responses' &&
      headers['content-type'] === 'application/json') {
    let parsed;
    const sourceText = body.toString('utf8');
    if (policy.profile === 'native-read' && !Buffer.from(sourceText, 'utf8').equals(body))
      return { ok: false, code: 'BODY_INVALID' };
    try { parsed = JSON.parse(sourceText); } catch { return { ok: false, code: 'BODY_INVALID' }; }
    if (policy.profile === 'native-read') {
      const keys = Object.keys(parsed ?? {}).sort();
      const allowedKeys = ['include', 'input', 'instructions', 'max_output_tokens',
        'model', 'previous_response_id', 'prompt_cache_key', 'store', 'stream', 'tools'];
      const requiredKeys = ['include', 'input', 'instructions', 'max_output_tokens',
        'model', 'prompt_cache_key', 'store', 'stream', 'tools'];
      const reject = code => ({ ok: false, code });
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return reject('NATIVE_ENVELOPE_TYPE');
      if (keys.some(key => !allowedKeys.includes(key)) ||
          !requiredKeys.every(key => keys.includes(key)))
        return reject('NATIVE_TOP_LEVEL_FIELDS');
      if (!Array.isArray(parsed.include) || parsed.include.length !== 1 ||
          parsed.include[0] !== 'reasoning.encrypted_content')
        return reject('NATIVE_INCLUDE_INVALID');
      if (typeof parsed.instructions !== 'string' || parsed.instructions.length === 0 ||
          Buffer.byteLength(parsed.instructions) > 32_768 ||
          Buffer.from(parsed.instructions, 'utf8').toString('utf8') !== parsed.instructions)
        return reject('NATIVE_INSTRUCTIONS_INVALID');
      if (parsed.max_output_tokens !== 128_000)
        return reject('NATIVE_OUTPUT_TOKENS_INVALID');
      if (typeof parsed.prompt_cache_key !== 'string' ||
          !/^[\x20-\x7e]{45}$/.test(parsed.prompt_cache_key))
        return reject('NATIVE_CACHE_KEY_INVALID');
      if (parsed.store !== false || parsed.stream !== true)
        return reject('NATIVE_MODE_INVALID');
      if (parsed.model !== NATIVE_MODEL) return reject('NATIVE_MODEL_INVALID');
      if (typeof policy.workspace !== 'string' || !policy.workspace.startsWith('/tmp/'))
        return reject('NATIVE_WORKSPACE_INVALID');
      if (!nativeInputAllowed(parsed.input)) return reject('NATIVE_INPUT_INVALID');
      if (parsed.previous_response_id === undefined && Array.isArray(parsed.input) &&
            !parsed.input.some(item => item.type === 'function_call_output') &&
            !JSON.stringify(parsed.input).includes('NATIVE_READ_FILE_PROBE') &&
            !JSON.stringify(parsed.input).includes('NATIVE_READ_FILE_SCHEMA_PROBE') &&
            !parsed.input.some(item => item.call_id !== undefined || item.id !== undefined))
        return reject('NATIVE_INITIAL_CONTEXT_INVALID');
      if (parsed.previous_response_id !== undefined &&
          !NATIVE_RESPONSE_IDS.has(parsed.previous_response_id))
        return reject('NATIVE_RESPONSE_REFERENCE_INVALID');
      if (!nativeToolsAllowed(parsed.tools)) return reject('NATIVE_TOOLS_INVALID');
      let projectedInput = parsed.input;
      if (Array.isArray(parsed.input)) {
        projectedInput = [];
        for (const item of parsed.input) {
          if (item.type !== 'function_call') { projectedInput.push(item); continue; }
          let args;
          try { args = JSON.parse(item.arguments); }
          catch { return { ok: false, code: 'NATIVE_ARGUMENTS_REJECTED' }; }
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return { ok: false, code: 'NATIVE_ARGUMENTS_REJECTED' };
          }
          if (item.name === 'muse.read_file' &&
              (Object.keys(args).sort().join(',') !== 'limit,offset,path' ||
                args.path !== join(policy.workspace, 'read-canary.txt') ||
                args.offset !== 1 || args.limit !== 20)) {
            return { ok: false, code: 'NATIVE_ARGUMENTS_REJECTED' };
          }
          projectedInput.push({ ...item, arguments: JSON.stringify(args) });
        }
      }
      // The reviewed provider validates each selected schema and issued call.
      // Canonicalizing here removes duplicate keys and unreviewed wire bytes.
      return { ok: true, route: 'responses', body: Buffer.from(JSON.stringify({
        model: NATIVE_MODEL, input: projectedInput, tools: parsed.tools,
        ...(parsed.previous_response_id === undefined ? {} :
          { previous_response_id: parsed.previous_response_id }),
      })) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'input,model,tools' ||
        parsed.model !== policy.model || typeof parsed.input !== 'string' ||
        !policy.allowedInputs.includes(parsed.input) ||
        !Array.isArray(parsed.tools) || parsed.tools.length !== 0) {
      return { ok: false, code: 'MODEL_OR_BODY_REJECTED' };
    }
    // Forward a canonical projection, never the untrusted bytes that JSON.parse
    // accepted. Duplicate keys and discarded fields cannot ride upstream.
    return { ok: true, route: 'responses',
      body: Buffer.from(JSON.stringify({ model: policy.model, input: parsed.input, tools: [] })) };
  }
  return { ok: false, code: 'ROUTE_OR_METHOD_REJECTED' };
}

export function nativeRejectionProjection(body, { index, stage, code, complete = true,
  receivedBytes = body.length }) {
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { /* shape remains invalid */ }
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const input = object?.input;
  const items = Array.isArray(input) ? input : [];
  const tools = Array.isArray(object?.tools) ? object.tools : [];
  const classify = (value, allowed) => value === undefined ? 'absent' :
    typeof value !== 'string' ? 'wrong_type' : allowed.has(value) ? 'reviewed' : 'foreign';
  const schemaShape = schema => {
    const result = { nodes: 0, maximumDepth: 0, properties: 0, omittedNodes: 0 };
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (depth > 8 || result.nodes >= 64) { result.omittedNodes++; return; }
      result.nodes++;
      result.maximumDepth = Math.max(result.maximumDepth, depth);
      const properties = value.properties;
      if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        const children = Object.values(properties);
        result.properties += children.length;
        children.slice(0, 16).forEach(child => visit(child, depth + 1));
        result.omittedNodes += Math.max(0, children.length - 16);
      }
      if (value.items) visit(value.items, depth + 1);
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(value[key])) {
          value[key].slice(0, 8).forEach(child => visit(child, depth + 1));
          result.omittedNodes += Math.max(0, value[key].length - 8);
        }
      }
    };
    visit(schema, 0);
    return result;
  };
  const itemClasses = items.slice(0, 8).map(item => ({
    class: item?.type === 'message' || item?.type === 'function_call' ||
      item?.type === 'function_call_output' || item?.type === 'reasoning' ? item.type : 'other',
    fieldCount: item && typeof item === 'object' && !Array.isArray(item) ?
      Math.min(Object.keys(item).length, 64) : 0,
    id: classify(item?.id, NATIVE_ITEM_IDS),
    callId: classify(item?.call_id, NATIVE_CALL_IDS),
    argumentType: type(item?.arguments), outputType: type(item?.output),
  }));
  const toolClasses = tools.slice(0, 2).map(namespace => ({
    class: namespace?.type === 'namespace' ? 'namespace' : 'other',
    fieldCount: namespace && typeof namespace === 'object' && !Array.isArray(namespace) ?
      Math.min(Object.keys(namespace).length, 64) : 0,
    functionCount: Array.isArray(namespace?.tools) ? Math.min(namespace.tools.length, 512) : 0,
    functionSamples: Array.isArray(namespace?.tools) ? namespace.tools.slice(0, 4).map(tool => ({
      class: tool?.type === 'function' ? 'function' : 'other',
      fieldCount: tool && typeof tool === 'object' && !Array.isArray(tool) ?
        Math.min(Object.keys(tool).length, 64) : 0,
      schemaType: type(tool?.parameters),
      schemaFieldCount: tool?.parameters && typeof tool.parameters === 'object' &&
        !Array.isArray(tool.parameters) ? Math.min(Object.keys(tool.parameters).length, 64) : 0,
      schemaShape: schemaShape(tool?.parameters),
    })) : [],
    omittedFunctions: Array.isArray(namespace?.tools) ? Math.max(0, namespace.tools.length - 4) : 0,
  }));
  const baseFields = new Set(['model', 'input', 'tools', 'previous_response_id']);
  const extraFields = object ? Object.keys(object).filter(key => !baseFields.has(key)) : [];
  const include = object?.include;
  const includeKinds = new Set(['reasoning.encrypted_content', 'file_search_call.results',
    'web_search_call.results', 'message.input_image.image_url']);
  const instructionBytes = typeof object?.instructions === 'string' ?
    Buffer.byteLength(object.instructions) : null;
  const cacheKey = object?.prompt_cache_key;
  const cacheKeyBytes = typeof cacheKey === 'string' ? Buffer.byteLength(cacheKey) : null;
  const outputTokens = object?.max_output_tokens;
  const outputTokenValue = Number.isSafeInteger(outputTokens) && outputTokens > 0 &&
    outputTokens <= 1_000_000 ? outputTokens : null;
  const reasoning = object?.reasoning;
  const reasoningMembers = reasoning && typeof reasoning === 'object' &&
    !Array.isArray(reasoning) ? Object.keys(reasoning) : [];
  const reasoningMemberShape = value => {
    const shape = { class: type(value) };
    if (typeof value === 'string') {
      const bytes = Buffer.byteLength(value);
      shape.byteCount = Math.min(bytes, 8_192);
      shape.moreBytes = bytes > 8_192;
    } else if (Array.isArray(value)) {
      shape.memberCount = Math.min(value.length, 64);
      shape.moreMembers = value.length > 64;
    }
    return shape;
  };
  const reasoningShape = { class: type(reasoning),
    memberCount: Math.min(reasoningMembers.length, 64),
    moreMembers: reasoningMembers.length > 64,
    recognizedMembers: Object.fromEntries(NATIVE_REASONING_CAPTURE_FIELDS
      .filter(key => Object.hasOwn(reasoning ?? {}, key))
      .map(key => [key, reasoningMemberShape(reasoning[key])])),
    unknownMemberCount: Math.min(reasoningMembers.filter(key =>
      !NATIVE_REASONING_CAPTURE_FIELDS.includes(key)).length, 64) };
  const diagnostic = { coverage: { inputItems: 0, namespaces: 0, functions: 0,
    schemaNodes: 0, schemaNodeLimit: NATIVE_DIAGNOSTIC_SCHEMA_NODE_LIMIT,
    admissionSchemaNodes: 0, admissionSchemaNodeLimit: 512,
    invalidParents: 0, blockedParents: {}, unexaminedSchemaSubtrees: 0,
    unexaminedWorkspaceArgumentChecks: 0, unexaminedInitialContextChecks: 0 },
  violations: {}, examples: [], violationsOmittedFromExamples: 0 };
  const blocked = kind => {
    diagnostic.coverage.invalidParents++;
    diagnostic.coverage.blockedParents[kind] =
      (diagnostic.coverage.blockedParents[kind] ?? 0) + 1;
  };
  const note = (violation, location = {}) => {
    diagnostic.violations[violation] = (diagnostic.violations[violation] ?? 0) + 1;
    if (diagnostic.examples.length < 12) diagnostic.examples.push({ code: violation, ...location });
    else diagnostic.violationsOmittedFromExamples++;
  };
  const topKeys = ['include', 'input', 'instructions', 'max_output_tokens', 'model',
    'previous_response_id', 'prompt_cache_key', 'store', 'stream', 'tools'];
  const requiredTopKeys = topKeys.filter(key => key !== 'previous_response_id');
  if (!object) {
    note('NATIVE_ENVELOPE_TYPE', { class: type(parsed) });
    blocked('envelope');
  } else {
    const unknownTop = Object.keys(object).filter(key => !topKeys.includes(key)).length;
    const missingTop = requiredTopKeys.filter(key => !Object.hasOwn(object, key)).length;
    if (unknownTop || missingTop) note('NATIVE_TOP_LEVEL_FIELDS',
      { unknownFieldCount: Math.min(unknownTop, 64), missingFieldCount: missingTop });
    if (!Array.isArray(object.include) || object.include.length !== 1 ||
        object.include[0] !== 'reasoning.encrypted_content') note('NATIVE_INCLUDE_INVALID');
    if (typeof object.instructions !== 'string' || !object.instructions.length ||
        Buffer.byteLength(object.instructions) > 32_768 ||
        Buffer.from(object.instructions, 'utf8').toString('utf8') !== object.instructions)
      note('NATIVE_INSTRUCTIONS_INVALID', { class: type(object.instructions),
        byteCount: typeof object.instructions === 'string' ?
          Math.min(Buffer.byteLength(object.instructions), 32_769) : null });
    if (object.max_output_tokens !== 128_000) note('NATIVE_OUTPUT_TOKENS_INVALID');
    if (typeof object.prompt_cache_key !== 'string' ||
        !/^[\x20-\x7e]{45}$/.test(object.prompt_cache_key)) note('NATIVE_CACHE_KEY_INVALID');
    if (object.store !== false || object.stream !== true) note('NATIVE_MODE_INVALID');
    if (object.model !== NATIVE_MODEL) note('NATIVE_MODEL_INVALID');
    if (object.previous_response_id !== undefined &&
        !NATIVE_RESPONSE_IDS.has(object.previous_response_id))
      note('NATIVE_RESPONSE_REFERENCE_INVALID');
    if (typeof input !== 'string' && !Array.isArray(input)) {
      note('NATIVE_INPUT_INVALID', { class: type(input) });
      blocked('input');
    } else if (Array.isArray(input)) {
      diagnostic.coverage.inputItems = input.length;
      const inputAllowed = nativeInputAllowed(input);
      if (!inputAllowed) note('NATIVE_INPUT_INVALID');
      for (const [inputIndex, item] of input.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            !['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type)) {
          note('NATIVE_INPUT_ITEM_INVALID', { inputIndex, class: type(item) });
          blocked('inputItem');
          continue;
        }
        if (item.id !== undefined && !NATIVE_ITEM_IDS.has(item.id) &&
            item.id !== 'msg_native_read_file_2' ||
            item.call_id !== undefined && !NATIVE_CALL_IDS.has(item.call_id))
          note('NATIVE_INPUT_REFERENCE_INVALID', { inputIndex });
        if (typeof item.arguments === 'string' && Buffer.byteLength(item.arguments) > 4_096 ||
            typeof item.output === 'string' && Buffer.byteLength(item.output) > 8_192)
          note('NATIVE_INPUT_SIZE_INVALID', { inputIndex });
        if (item.type === 'function_call' && typeof item.arguments === 'string') {
          try {
            const argumentsObject = JSON.parse(item.arguments);
            if (!argumentsObject || typeof argumentsObject !== 'object' ||
                Array.isArray(argumentsObject)) note('NATIVE_ARGUMENTS_REJECTED', { inputIndex });
            else if (item.name === 'muse.read_file')
              diagnostic.coverage.unexaminedWorkspaceArgumentChecks++;
          } catch { note('NATIVE_ARGUMENTS_REJECTED', { inputIndex }); }
        }
      }
      if (!inputAllowed) {
        blocked('initialContext');
        diagnostic.coverage.unexaminedInitialContextChecks++;
      } else if (object.previous_response_id === undefined &&
          !input.some(item => item?.type === 'function_call_output') &&
          !JSON.stringify(input).includes('NATIVE_READ_FILE_PROBE') &&
          !JSON.stringify(input).includes('NATIVE_READ_FILE_SCHEMA_PROBE') &&
          !input.some(item => item?.call_id !== undefined || item?.id !== undefined))
        note('NATIVE_INITIAL_CONTEXT_INVALID');
    } else if (!nativeInputAllowed(input)) note('NATIVE_INPUT_INVALID',
      { class: 'string', byteCount: Math.min(Buffer.byteLength(input), 32_769) });
    if (!Array.isArray(object.tools)) {
      note('NAMESPACE_COUNT', { class: type(object.tools) });
      blocked('tools');
    } else {
      diagnostic.coverage.namespaces = object.tools.length;
      if (object.tools.length !== 1) note('NAMESPACE_COUNT',
        { namespaceCount: Math.min(object.tools.length, 64) });
      const schemaKeys = NATIVE_SCHEMA_KEYS;
      const typeLabels = NATIVE_SCHEMA_TYPES;
      for (const namespace of object.tools) {
        if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace) ||
            !Array.isArray(namespace.tools)) {
          note('NAMESPACE_SHAPE', { class: type(namespace) });
          blocked('namespace');
          continue;
        }
        if (namespace.type !== 'namespace' || namespace.name !== 'muse' ||
            ![1, 25].includes(namespace.tools.length) ||
            namespace.description !== undefined &&
              (typeof namespace.description !== 'string' ||
                Buffer.byteLength(namespace.description) > 2_048) ||
            Object.keys(namespace).some(key => !['type', 'name', 'description', 'tools'].includes(key)))
          note('NAMESPACE_SHAPE');
        const names = namespace.tools.map(tool => tool?.name);
        if (new Set(names).size !== names.length ||
            names.length === 25 && names[1] !== 'read_file' ||
            names.length === 1 && names[0] !== 'submit_reminder_decision')
          note('FUNCTION_NAME_SET');
        diagnostic.coverage.functions += namespace.tools.length;
        for (const [functionIndex, tool] of namespace.tools.entries()) {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
            note('FUNCTION_TYPE', { functionIndex, class: type(tool) });
            blocked('function');
            continue;
          }
          if (tool.type !== 'function') note('FUNCTION_TYPE', { functionIndex });
          if (typeof tool.name !== 'string' || !/^[a-z_][a-z0-9_]{0,63}$/.test(tool.name))
            note('FUNCTION_NAME_SYNTAX', { functionIndex });
          if (Object.keys(tool).some(key =>
            !['type', 'name', 'description', 'parameters', 'strict'].includes(key)))
            note('FUNCTION_FIELDS', { functionIndex });
          if (tool.strict !== undefined && typeof tool.strict !== 'boolean')
            note('FUNCTION_STRICT', { functionIndex });
          const descriptionLimit = namespace.tools.length === 25 && functionIndex === 0 ?
            8_192 : 2_048;
          if (tool.description !== undefined && (typeof tool.description !== 'string' ||
              Buffer.byteLength(tool.description) > descriptionLimit ||
              Buffer.from(tool.description, 'utf8').toString('utf8') !== tool.description))
            note('FUNCTION_DESCRIPTION', { functionIndex, class: type(tool.description),
              byteCount: typeof tool.description === 'string' ?
                Math.min(Buffer.byteLength(tool.description), descriptionLimit + 1) : null });
          const pending = [{ value: tool.parameters, depth: 0 }];
          while (pending.length) {
            const { value, depth } = pending.pop();
            if (diagnostic.coverage.schemaNodes >= NATIVE_DIAGNOSTIC_SCHEMA_NODE_LIMIT) {
              diagnostic.coverage.unexaminedSchemaSubtrees += pending.length + 1;
              break;
            }
            diagnostic.coverage.schemaNodes++;
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              note('SCHEMA_SHAPE', { functionIndex, depth, class: type(value) });
              blocked('schema');
              continue;
            }
            if (depth <= 8 && ++diagnostic.coverage.admissionSchemaNodes === 513)
              note('SCHEMA_COMPLEXITY', { functionIndex, depth });
            if (depth > 8) note('SCHEMA_COMPLEXITY', { functionIndex, depth });
            const keys = Object.keys(value);
            const unknown = keys.filter(key => !schemaKeys.has(key)).length;
            if (unknown) note('SCHEMA_KEYS', { functionIndex, depth,
              unknownFieldCount: Math.min(unknown, 64) });
            for (const key of keys) {
              if (!schemaKeys.has(key)) continue;
              const child = value[key];
              const location = { functionIndex, depth, keyword: key, class: type(child) };
              if (key === 'properties') {
                if (!child || typeof child !== 'object' || Array.isArray(child)) {
                  note('SCHEMA_PROPERTIES', location); blocked('properties');
                } else {
                  if (Object.keys(child).length > 64) note('SCHEMA_PROPERTIES', location);
                  for (const nested of Object.values(child)) pending.push({ value: nested, depth: depth + 1 });
                }
              } else if (key === 'items' || key === 'additionalProperties' &&
                  child && typeof child === 'object') {
                pending.push({ value: child, depth: depth + 1 });
              } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
                if (!Array.isArray(child) || child.length < 1 || child.length > 8) {
                  note('SCHEMA_COMPOSITION', location);
                  if (!Array.isArray(child)) blocked('composition');
                }
                if (Array.isArray(child)) for (const nested of child)
                  pending.push({ value: nested, depth: depth + 1 });
              } else if (key === 'type') {
                const values = Array.isArray(child) ? child : [child];
                const expanded = namespace.tools.length === 25 && functionIndex === 0 && depth === 1 &&
                  Array.isArray(child);
                if (!values.length || values.length > (expanded ? 6 : 3) ||
                    values.some(label => !typeLabels.includes(label)) ||
                    expanded && new Set(values).size !== values.length)
                  note('SCHEMA_TYPE', { ...location, memberCount: Math.min(values.length, 64) });
              } else if (key === 'description' || key === 'title') {
                const limit = key === 'description' && namespace.tools.length === 25 &&
                  functionIndex === 0 && depth === 1 ? 8_192 : 2_048;
                if (typeof child !== 'string' || Buffer.byteLength(child) > limit ||
                    limit === 8_192 &&
                    Buffer.from(child, 'utf8').toString('utf8') !== child)
                  note('SCHEMA_DESCRIPTION', { ...location, byteCount: typeof child === 'string' ?
                    Math.min(Buffer.byteLength(child), limit + 1) : null });
              } else if (key === 'required' && (!Array.isArray(child) || child.length > 64 ||
                  child.some(item => typeof item !== 'string' || item.length > 64) ||
                  new Set(child).size !== child.length))
                note('SCHEMA_REQUIRED', location);
              else if (key === 'enum' || key === 'examples') {
                if (!Array.isArray(child) || child.length > 16 ||
                    child.some(item => item !== null &&
                      (!['string', 'number', 'boolean'].includes(typeof item) ||
                        typeof item === 'string' && Buffer.byteLength(item) > 2_048)))
                  note('SCHEMA_ENUM', location);
              } else if (key === 'const') {
                if (child !== null && !['string', 'number', 'boolean'].includes(typeof child) ||
                    typeof child === 'string' && Buffer.byteLength(child) > 2_048)
                  note('SCHEMA_CONST', location);
              } else if (key === 'nullable' || key === 'additionalProperties') {
                if (typeof child !== 'boolean') note('SCHEMA_BOOLEAN', location);
              } else if (!['required'].includes(key) &&
                  (typeof child !== 'number' || !Number.isFinite(child) ||
                    Math.abs(child) > 1_000_000)) {
                note('SCHEMA_NUMBER', location);
              }
            }
          }
        }
      }
    }
  }
  const projection = { schemaVersion: 1, requestIndex: index, byteCount: receivedBytes,
    capturedByteCount: body.length, omittedByteCount: Math.max(0, receivedBytes - body.length),
    bodyComplete: complete, capturedSha256: createHash('sha256').update(body).digest('hex'),
    stage, failedPredicates: [code],
    topLevel: { class: type(parsed), knownFieldTypes: Object.fromEntries(
      ['model', 'input', 'tools', 'previous_response_id'].map(key => [key, type(object?.[key])])),
      unknownFieldCount: extraFields.length,
      recognizedExtraFieldTypes: Object.fromEntries(NATIVE_TOP_LEVEL_CAPTURE_FIELDS
        .filter(key => Object.hasOwn(object ?? {}, key)).map(key => [key, type(object[key])])),
      unrecognizedExtraFieldCount: extraFields.filter(key =>
        !NATIVE_TOP_LEVEL_CAPTURE_FIELDS.includes(key)).length,
      observedExtraFieldShapes: {
        include: Array.isArray(include) ? { count: include.length,
          members: include.slice(0, 8).map(value => includeKinds.has(value) ? value : 'other'),
          omittedMembers: Math.max(0, include.length - 8) } : { class: type(include) },
        instructions: { byteCount: instructionBytes },
        maxOutputTokens: { safePositiveValue: outputTokenValue,
          class: outputTokenValue === null ? type(outputTokens) : 'safe_positive_integer' },
        promptCacheKey: { byteCount: cacheKeyBytes,
          format: typeof cacheKey !== 'string' ? type(cacheKey) : cacheKey.length === 0 ?
            'empty' : /^[\x20-\x7e]+$/.test(cacheKey) ? 'printable_ascii' : 'other' },
        reasoning: reasoningShape,
        store: typeof object?.store === 'boolean' ? object.store : type(object?.store),
        stream: typeof object?.stream === 'boolean' ? object.stream : type(object?.stream),
      } },
    input: { class: type(input), itemCount: items.length, itemClasses,
      omittedItems: Math.max(0, items.length - itemClasses.length) },
    previousResponse: classify(object?.previous_response_id, NATIVE_RESPONSE_IDS),
    diagnostic,
    tools: { class: type(object?.tools), namespaceCount: tools.length, toolClasses,
      omittedNamespaces: Math.max(0, tools.length - toolClasses.length),
      failure: code === 'NATIVE_TOOLS_INVALID' ? nativeToolsFailure(object?.tools) : null } };
  while (Buffer.byteLength(JSON.stringify(projection)) + 1 > NATIVE_CAPTURE_ARTIFACT_LIMIT) {
    const sampledNamespace = projection.tools.toolClasses.find(namespace =>
      namespace.functionSamples.length > 0);
    if (projection.diagnostic.examples.length > 0) {
      projection.diagnostic.examples.pop();
      projection.diagnostic.violationsOmittedFromExamples++;
    } else if (sampledNamespace) {
      sampledNamespace.functionSamples.pop();
      sampledNamespace.omittedFunctions++;
    } else if (projection.input.itemClasses.length > 0) {
      projection.input.itemClasses.pop();
      projection.input.omittedItems++;
    } else if (projection.tools.toolClasses.length > 0) {
      projection.tools.toolClasses.pop();
      projection.tools.omittedNamespaces++;
    } else {
      throw fault('NATIVE_CAPTURE_BOUND_INVALID', 'fixed projection exceeds artifact limit');
    }
  }
  return projection;
}

export async function assertSocketIdentity(socketPath, identity, inspect = lstat) {
  const current = await inspect(socketPath);
  if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino ||
      (current.mode & 0o777) !== 0o600) {
    throw fault('SOCKET_REPLACED', 'task relay socket identity or mode changed');
  }
}

export async function startBroker({ socketPath, upstreamOrigin, runId, bearer,
  profile = 'controlled', workspace = null,
  model = MODEL, requestLimit = REQUEST_LIMIT, responseLimit = RESPONSE_LIMIT,
  concurrency = 2, deadlineMs = 3_000, allowedInputs = ['fixture'],
  perRouteBudget = 1,
  inspectSocket = assertSocketIdentity, writeCapture = writeFile,
  projectCapture = nativeRejectionProjection }) {
  if (!['controlled', 'native-read'].includes(profile)) {
    throw fault('BROKER_POLICY_INVALID', 'unknown synthetic relay profile');
  }
  if (profile === 'native-read') {
    if (typeof workspace !== 'string' || !workspace.startsWith('/tmp/') ||
        workspace.endsWith('/') || workspace.includes('/../')) {
      throw fault('BROKER_POLICY_INVALID', 'native workspace path is not exact');
    }
    if (model !== MODEL || requestLimit !== REQUEST_LIMIT || responseLimit !== RESPONSE_LIMIT ||
        concurrency !== 2 || deadlineMs !== 3_000 || perRouteBudget !== 1 ||
        allowedInputs.length !== 1 || allowedInputs[0] !== 'fixture') {
      throw fault('BROKER_POLICY_INVALID', 'native policy budgets are fixed');
    }
    model = NATIVE_MODEL;
    requestLimit = NATIVE_REQUEST_LIMIT;
    responseLimit = RESPONSE_LIMIT;
    perRouteBudget = 5;
    deadlineMs = 5_000;
  }
  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' ||
      !Number.isSafeInteger(Number(upstream.port)) || Number(upstream.port) < 1 ||
      upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password ||
      !/^[A-Za-z0-9_-]{12,80}$/.test(runId) ||
      typeof bearer !== 'string' || bearer.length < 24 || bearer === DUMMY ||
      !Array.isArray(allowedInputs) || allowedInputs.length < 1 || allowedInputs.length > 8 ||
      allowedInputs.some(value => typeof value !== 'string' || !/^[a-z]{1,32}$/.test(value)) ||
      !Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit >
        (profile === 'native-read' ? NATIVE_REQUEST_LIMIT : REQUEST_LIMIT) ||
      !Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > RESPONSE_LIMIT ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isSafeInteger(perRouteBudget) || perRouteBudget < 1 || perRouteBudget > 8 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 5_000) {
    throw fault('BROKER_POLICY_INVALID', 'synthetic broker origin, run or bearer invalid');
  }
  const policy = { runId, model, allowedInputs, profile, workspace };
  const evidence = { accepted: 0, rejected: 0, upstream: 0, disconnected: 0, responseLimit: 0, deadline: 0 };
  const capturePath = join(dirname(socketPath), 'first-rejected-native-post.json');
  let resolveFailure;
  const failure = new Promise(resolveValue => { resolveFailure = resolveValue; });
  let captureStarted = false;
  let captureFinished = Promise.resolve();
  let captureSealed = false;
  const capturedPostIndices = new Set();
  const captureRecords = new Map();
  const captureAbort = new AbortController();
  const settleCapture = (record, result) => {
    if (record.status !== 'pending') return;
    record.status = result.status;
    Object.assign(record.visible, result);
  };
  let nativePostIndex = 0;
  const markFailure = (code, stage, incoming, body = Buffer.alloc(0), index = null,
    complete = true, receivedBytes = body.length) => {
    if (profile !== 'native-read') return captureFinished;
    if (!evidence.firstFailure) {
      evidence.firstFailure = { code: boundedCode({ code }), stage };
      resolveFailure(evidence.firstFailure);
    }
    const postIndex = index ?? nativePostIndex;
    if (incoming?.method === 'POST' && !captureSealed &&
        (!captureStarted || postIndex <= 5) &&
        !capturedPostIndices.has(postIndex)) {
      capturedPostIndices.add(postIndex);
      const firstCapture = !captureStarted;
      captureStarted = true;
      const path = firstCapture ? capturePath :
        join(dirname(socketPath), `rejected-native-post-${postIndex}.json`);
      const visible = firstCapture ? { status: 'pending' } :
        { index: postIndex, status: 'pending' };
      if (firstCapture) evidence.capture = visible;
      else (evidence.additionalCaptures ??= []).push(visible);
      const record = { status: 'pending', visible };
      captureRecords.set(postIndex, record);
      let projection;
      try {
        projection = projectCapture(body,
          { index: postIndex, stage, code: boundedCode({ code }), complete, receivedBytes });
      } catch (error) {
        settleCapture(record, { status: 'failed', code: boundedCode(error) });
        return captureFinished;
      }
      const written = Promise.resolve().then(() => writeCapture(path,
        `${JSON.stringify(projection)}\n`, { flag: 'wx', mode: 0o600,
          signal: captureAbort.signal }))
        .then(() => settleCapture(record, { status: 'written', path }),
          error => settleCapture(record,
            { status: 'failed', code: boundedCode(error) }));
      captureFinished = Promise.all([captureFinished, written]).then(() => undefined);
    }
    return captureFinished;
  };
  const routeUses = { catalog: 0, responses: 0 };
  const nativeRequestDigests = new Set();
  let aggregateRequestBytes = 0;
  let aggregateResponseBytes = 0;
  let active = 0;
  let socketIdentity;
  const server = createServer(async (incoming, outgoing) => {
    const postIndex = incoming.method === 'POST' && profile === 'native-read' ? ++nativePostIndex : null;
    incoming.setTimeout(deadlineMs, () => incoming.destroy(fault('GUEST_REQUEST_TIMEOUT', 'guest request timed out')));
    outgoing.setTimeout(deadlineMs, () => outgoing.destroy());
    if (active >= concurrency) { evidence.rejected++;
      await markFailure('CONCURRENCY_LIMIT', 'concurrency', incoming, Buffer.alloc(0), postIndex, false);
      send(outgoing, 429, 'CONCURRENCY_LIMIT'); return; }
    active++;
    let upstreamRequest;
    const chunks = [];
    let requestBodyComplete = false;
    let receivedBytes = 0;
    let capturedBytes = 0;
    let deadlineExpired = false;
    let completed = false;
    const wholeDeadline = setTimeout(() => {
      if (completed) return;
      deadlineExpired = true;
      evidence.deadline++;
      void markFailure('WHOLE_OPERATION_DEADLINE', 'deadline', incoming,
        Buffer.concat(chunks), postIndex, requestBodyComplete, receivedBytes);
      incoming.destroy(fault('WHOLE_OPERATION_DEADLINE', 'relay operation timed out'));
      upstreamRequest?.destroy(fault('WHOLE_OPERATION_DEADLINE', 'relay operation timed out'));
      outgoing.destroy();
    }, deadlineMs);
    const finish = () => { if (completed) return; completed = true; active--; };
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) { evidence.disconnected++;
        void markFailure('GUEST_DISCONNECTED', 'disconnect', incoming,
          Buffer.concat(chunks), postIndex, requestBodyComplete, receivedBytes);
        upstreamRequest?.destroy(); }
      finish();
    });
    try {
      await inspectSocket(socketPath, socketIdentity);
      for await (const chunk of incoming) {
        receivedBytes += chunk.length;
        if (profile === 'native-read') aggregateRequestBytes += chunk.length;
        const take = Math.min(chunk.length, Math.max(0, requestLimit - capturedBytes));
        if (take > 0) { chunks.push(chunk.subarray(0, take)); capturedBytes += take; }
        if (receivedBytes > requestLimit) throw fault('REQUEST_LIMIT', 'guest request exceeded body budget');
        if (profile === 'native-read' && aggregateRequestBytes > NATIVE_AGGREGATE_REQUEST_LIMIT) {
          throw fault('REQUEST_LIMIT', 'native aggregate request budget exceeded');
        }
      }
      requestBodyComplete = true;
      const body = Buffer.concat(chunks);
      const decision = requestDecision(incoming, body, policy);
      if (!decision.ok) { evidence.rejected++;
        await markFailure(decision.code, 'admission', incoming, body, postIndex);
        send(outgoing, 403, decision.code); return; }
      if (profile === 'native-read' && decision.route === 'responses') {
        const digest = createHash('sha256').update(decision.body).digest('hex');
        if (nativeRequestDigests.has(digest)) {
          evidence.rejected++; await markFailure('NATIVE_REQUEST_REPLAY', 'replay', incoming, body, postIndex);
          send(outgoing, 403, 'NATIVE_REQUEST_REPLAY'); return;
        }
        nativeRequestDigests.add(digest);
      }
      if (routeUses[decision.route] >=
          (profile === 'native-read' && decision.route === 'catalog' ? 4 : perRouteBudget)) {
        evidence.rejected++; await markFailure('ROUTE_BUDGET', 'budget', incoming, body, postIndex);
        send(outgoing, 429, 'ROUTE_BUDGET'); return;
      }
      routeUses[decision.route]++;
      evidence.accepted++;
      const route = decision.route === 'catalog' ? '/muse-code/models' : '/responses';
      const forwarded = decision.body;
      await new Promise(resolveValue => {
        upstreamRequest = httpRequest(new URL(route, upstream), { method: incoming.method,
          headers: { authorization: `Bearer ${bearer}`,
            ...(route === '/responses' ? { 'content-type': 'application/json' } : {}),
            'accept': 'application/json, text/event-stream', 'content-length': String(forwarded.length) },
          timeout: deadlineMs, agent: false }, upstreamResponse => {
          if (upstreamResponse.statusCode >= 300 && upstreamResponse.statusCode < 400 ||
              upstreamResponse.headers.location) {
            upstreamResponse.destroy(); evidence.rejected++;
            void markFailure('UPSTREAM_REDIRECT_REJECTED', 'upstream', incoming, body, postIndex);
            send(outgoing, 502, 'UPSTREAM_REDIRECT_REJECTED');
            resolveValue(); return;
          }
          const contentType = String(upstreamResponse.headers['content-type'] ?? '').split(';')[0];
          if (upstreamResponse.statusCode !== 200 || !['application/json', 'text/event-stream'].includes(contentType)) {
            upstreamResponse.destroy(); evidence.rejected++;
            void markFailure('UPSTREAM_RESPONSE_REJECTED', 'upstream', incoming, body, postIndex);
            send(outgoing, 502, 'UPSTREAM_RESPONSE_REJECTED');
            resolveValue(); return;
          }
          if (profile === 'native-read') {
            const chunks = [];
            let total = 0;
            upstreamResponse.on('data', chunk => {
              total += chunk.length;
              aggregateResponseBytes += chunk.length;
              if (total > responseLimit || aggregateResponseBytes > RESPONSE_LIMIT) {
                evidence.responseLimit++;
                void markFailure('RESPONSE_LIMIT', 'response_budget', incoming, body, postIndex);
                upstreamRequest.destroy(); outgoing.destroy(); return;
              }
              chunks.push(chunk);
            });
            upstreamResponse.once('end', () => {
              if (outgoing.destroyed) { resolveValue(); return; }
              try {
                const payload = Buffer.concat(chunks);
                if (contentType === 'text/event-stream') validateNativeSse(payload);
                else {
                  const catalog = JSON.parse(payload.toString('utf8'));
                  if (catalog?.data?.[0]?.id !== NATIVE_MODEL ||
                      !Array.isArray(catalog.data) || catalog.data.length !== 1) {
                    throw fault('NATIVE_CATALOG_INVALID', 'native model catalog differed');
                  }
                }
                outgoing.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
                outgoing.end(payload);
              } catch { evidence.rejected++;
                void markFailure('NATIVE_UPSTREAM_INVALID', 'stream', incoming, body, postIndex);
                send(outgoing, 502, 'NATIVE_UPSTREAM_INVALID'); }
              resolveValue();
            });
            upstreamResponse.once('error', () => {
              void markFailure('UPSTREAM_STREAM_ERROR', 'stream', incoming, body, postIndex);
              outgoing.destroy(); resolveValue(); });
            outgoing.once('close', () => { upstreamResponse.destroy(); resolveValue(); });
            return;
          }
          outgoing.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
          let total = 0;
          upstreamResponse.on('data', chunk => {
            total += chunk.length;
            if (profile === 'native-read') aggregateResponseBytes += chunk.length;
            if (total > responseLimit ||
                profile === 'native-read' && aggregateResponseBytes > RESPONSE_LIMIT) {
              evidence.responseLimit++; upstreamRequest.destroy(); outgoing.destroy(); return;
            }
            if (!outgoing.write(chunk)) upstreamResponse.pause();
          });
          outgoing.on('drain', () => upstreamResponse.resume());
          upstreamResponse.once('end', () => { if (!outgoing.destroyed) outgoing.end(); resolveValue(); });
          upstreamResponse.once('error', () => { if (!outgoing.destroyed) outgoing.destroy(); resolveValue(); });
          outgoing.once('close', () => { upstreamResponse.destroy(); resolveValue(); });
        });
        upstreamRequest.once('error', () => {
          void markFailure('UPSTREAM_UNAVAILABLE', 'upstream', incoming, body, postIndex);
          if (!outgoing.headersSent) send(outgoing, 502, 'UPSTREAM_UNAVAILABLE');
          else outgoing.destroy(); resolveValue(); });
        upstreamRequest.once('timeout', () => upstreamRequest.destroy(fault('UPSTREAM_TIMEOUT', 'upstream timed out')));
        evidence.upstream++;
        upstreamRequest.end(forwarded);
      });
    } catch (error) {
      evidence.rejected++;
      await markFailure(boundedCode(error), 'broker_error', incoming,
        Buffer.concat(chunks), postIndex, requestBodyComplete, receivedBytes);
      if (!deadlineExpired) send(outgoing, error.code === 'REQUEST_LIMIT' ? 413 : 503, error.code ?? 'BROKER_UNAVAILABLE');
    } finally { clearTimeout(wholeDeadline); if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end(); finish(); }
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = deadlineMs;
  server.headersTimeout = deadlineMs;
  await awaitListen(server, socketPath);
  await chmod(socketPath, 0o600);
  const entry = await lstat(socketPath);
  socketIdentity = { dev: entry.dev, ino: entry.ino };
  await assertSocketIdentity(socketPath, socketIdentity);
  return { socketPath, identity: socketIdentity, evidence, failure,
    flushCapture: () => captureFinished,
    cancelCapture: code => {
      if (!captureStarted || captureSealed) return;
      const pending = [...captureRecords.values()].filter(record => record.status === 'pending');
      if (!pending.length) return;
      captureSealed = true;
      for (const record of pending)
        settleCapture(record, { status: 'unverified', code: boundedCode({ code }) });
      captureAbort.abort();
    },
    get listening() { return server.listening; },
    close: async () => {
      let replacement;
      let mismatch;
      try { await assertSocketIdentity(socketPath, socketIdentity); }
      catch (error) { mismatch = error; }
      if (mismatch) {
        // Node closes a pathname socket by unlinking its path. Move a replacement
        // aside before stopping the owned listener, then restore that exact object.
        try {
          const observed = await lstat(socketPath);
          const heldPath = `${socketPath}.held-${randomBytes(6).toString('hex')}`;
          await rename(socketPath, heldPath);
          replacement = { heldPath, dev: observed.dev, ino: observed.ino };
        } catch (error) { if (error.code !== 'ENOENT') mismatch = error; }
      }
      let closeError;
      try { await close(server); } catch (error) { closeError = error; }
      let preserved = true;
      if (replacement) {
        try {
          const occupied = await lstat(socketPath).then(() => true, error => error.code !== 'ENOENT');
          if (occupied) preserved = false;
          else {
            await rename(replacement.heldPath, socketPath);
            const restored = await lstat(socketPath);
            preserved = restored.dev === replacement.dev && restored.ino === replacement.ino;
          }
        } catch { preserved = false; }
      }
      if (mismatch || closeError || !preserved) {
        throw Object.assign(fault('SOCKET_STOP_UNVERIFIED', 'broker stopped with replaced or uncertain socket path'),
          { listenerStopped: !server.listening && !closeError, replacementPreserved: preserved });
      }
      if (await lstat(socketPath).then(() => true, error => error.code !== 'ENOENT')) {
        throw fault('SOCKET_STOP_UNVERIFIED', 'task relay socket path remained after close');
      }
    } };
}

export async function startGuestRelay(socketPath, runId) {
  const evidence = { requests: 0 };
  const server = createServer((incoming, outgoing) => {
    evidence.requests++;
    if (evidence.requests > 9) { send(outgoing, 429, 'GUEST_RELAY_BUDGET'); return; }
    incoming.setTimeout(3_000, () => incoming.destroy());
    outgoing.setTimeout(3_000, () => outgoing.destroy());
    const headers = { host: '127.0.0.1:1', authorization: `Bearer ${DUMMY}`,
      'x-passeur-run': runId, 'accept': 'application/json, text/event-stream',
      ...(incoming.headers['content-type'] ? { 'content-type': incoming.headers['content-type'] } : {}),
      ...(incoming.headers['content-length'] ? { 'content-length': incoming.headers['content-length'] } : {}),
    };
    const forwarding = httpRequest({ socketPath, method: incoming.method, path: incoming.url,
      headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] ?? 'application/json' });
      response.pipe(outgoing);
    });
    forwarding.once('error', () => { if (!outgoing.headersSent) send(outgoing, 502, 'SOCKET_UNAVAILABLE');
      else outgoing.destroy(); });
    outgoing.once('close', () => forwarding.destroy());
    incoming.pipe(forwarding);
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = 3_000;
  server.headersTimeout = 3_000;
  await awaitListen(server, { host: '127.0.0.1', port: 0 });
  return { port: server.address().port, evidence, close: () => close(server) };
}

async function fakeUpstream(bearer) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let bytes = 0;
    for await (const chunk of request) bytes += chunk.length;
    const correctBearer = request.headers.authorization === `Bearer ${bearer}`;
    seen.push({ route: request.url, method: request.method, correctBearer,
      dummyAbsent: !JSON.stringify(request.headers).includes(DUMMY), bytes });
    response.writeHead(correctBearer ? 200 : 401, { 'content-type': request.url === '/responses'
      ? 'text/event-stream' : 'application/json' });
    response.end(request.url === '/responses' ? 'data: {"type":"response.completed"}\n\n'
      : JSON.stringify({ object: 'list', data: [{ id: MODEL }] }));
  });
  await awaitListen(server, { host: '127.0.0.1', port: 0 });
  return { origin: `http://127.0.0.1:${server.address().port}/`, seen, close: () => close(server) };
}

export async function startNativeUpstream({ bearer, workspace, protectedRoot,
  canaryToken, hostPort }) {
  if (typeof bearer !== 'string' || bearer.length < 24 || bearer === DUMMY ||
      typeof workspace !== 'string' || !workspace.startsWith('/tmp/') ||
      typeof protectedRoot !== 'string' || typeof canaryToken !== 'string') {
    throw fault('NATIVE_UPSTREAM_CONFIG_INVALID', 'native fake provider config invalid');
  }
  const seen = [];
  const provider = await startShellProvider(hostPort, 'NATIVE_READ_FILE_ONLY', {
    readFileProbe: true, workspace, protectedRoot, canaryToken,
    makeServer: handler => createServer((request, response) => {
      const correctBearer = request.headers.authorization === `Bearer ${bearer}`;
      seen.push({ method: request.method, path: request.url,
        correctBearer, dummyAbsent: !JSON.stringify(request.headers).includes(DUMMY) });
      if (!correctBearer) { response.writeHead(401).end(); return; }
      handler(request, response);
    }),
  });
  return { origin: `http://127.0.0.1:${provider.port}/`, provider, seen,
    close: () => provider.close() };
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return true; throw error; }
}

export async function guestFixture(config) {
  const loopback = spawnSync('/usr/sbin/ip', ['-o', 'link', 'show', 'lo'], { encoding: 'utf8', timeout: 2_000 });
  if (!loopbackReady(loopback)) throw fault('GUEST_LOOPBACK_UNAVAILABLE', 'guest loopback not UP');
  const relay = await startGuestRelay(GUEST_SOCKET, config.runId);
  try {
    const settings = '/mounts/home/.config/muse';
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'settings.json'), `${JSON.stringify({ schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${relay.port}`, auth: 'bearer' } })}\n`, { mode: 0o600 });
    await writeFile(join(settings, 'auth.json'), `${JSON.stringify({ schema_version: 1,
      providers: { meta: { api_key: DUMMY } } })}\n`, { mode: 0o600 });
    const hostTcp = await tcpProbe('127.0.0.1', config.hostPort);
    const external = await tcpProbe('203.0.113.1', 443);
    if (hostTcp.kind === 'connected' || !classifyNoRoute(external)) throw fault('GUEST_NETWORK_UNVERIFIED', 'guest network boundary unverified');
    const canaries = { direct: await absent(join(config.protectedRoot, 'marker')),
      symlink: await absent(join(config.workspace, 'protected-link', 'marker')),
      proc: await absent(`/proc/1/root${config.protectedRoot}/marker`) };
    if (Object.values(canaries).some(value => !value)) throw fault('CANARY_VISIBLE', 'protected canary visible');
    const url = `http://127.0.0.1:${relay.port}`;
    const headers = { authorization: `Bearer ${DUMMY}` };
    const catalog = await fetch(`${url}/muse-code/models`, { headers });
    const catalogBody = await catalog.json();
    const response = await fetch(`${url}/responses`, { method: 'POST', headers: { ...headers,
      'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: 'fixture', tools: [] }) });
    const sse = await response.text();
    if (catalog.status !== 200 || catalogBody.data?.[0]?.id !== MODEL || response.status !== 200 ||
        !sse.includes('response.completed')) throw fault('GUEST_RELAY_FAILED', 'guest relay fixture response invalid');
    return { kind: 'guest_relay_observed', relayPort: relay.port, hostTcp, external, canaries,
      catalog: catalog.status, responses: response.status, guestNamespace: await readlink('/proc/self/ns/net') };
  } finally { await relay.close(); }
}

export async function guestNativeFixture(config, {
  release, callerFailure,
  startRelay = startGuestRelay,
  checkLoopback = () => loopbackReady(spawnSync('/usr/sbin/ip', ['-o', 'link', 'show', 'lo'],
    { encoding: 'utf8', timeout: 2_000 })),
  runLifecycle = async (guestConfig, options) => {
    const { runNativeShellLifecycle } = await import('./qualify-muse-sandbox-transport.mjs');
    return runNativeShellLifecycle(guestConfig, options);
  },
} = {}) {
  if (typeof release !== 'function' || !callerFailure ||
      typeof callerFailure.then !== 'function' || config?.phase !== 'read-file-probe' ||
      typeof config.runId !== 'string') {
    throw fault('NATIVE_GUEST_CONFIG_INVALID', 'native relay guest lacks exact control inputs');
  }
  if (!checkLoopback()) throw fault('GUEST_LOOPBACK_UNAVAILABLE', 'guest loopback not UP');
  const relay = await startRelay(GUEST_SOCKET, config.runId);
  try {
    if (!Number.isSafeInteger(relay.port) || relay.port < 1 || relay.port > 65535 ||
        typeof relay.close !== 'function' ||
        !Number.isSafeInteger(relay.evidence?.requests) || relay.evidence.requests !== 0) {
      throw fault('NATIVE_RELAY_INVALID', 'guest relay did not return an exact endpoint');
    }
    let candidateRequests = null;
    return await runLifecycle({ ...config, release },
      { providerPort: relay.port, callerFailure,
        onCandidate: async () => {
          candidateRequests = relay.evidence.requests;
          if (candidateRequests < 1 || candidateRequests > 9) {
            throw fault('NATIVE_RELAY_REQUEST_BUDGET', 'guest relay request count invalid');
          }
          return [];
        },
        onFinal: async () => {
          if (candidateRequests === null || relay.evidence.requests !== candidateRequests) {
            throw fault('NATIVE_RELAY_AFTER_CANDIDATE', 'guest issued provider traffic after candidate turn');
          }
        } });
  } finally { await relay.close(); }
}

async function stage(root) {
  const runtime = join(root, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const node = await pinnedNode();
  await copyFile(node, join(runtime, 'node'));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(runtime, 'node'))) hash.update(chunk);
  const entry = await lstat(join(runtime, 'node'));
  if (hash.digest('hex') !== '16143bdaa79716e871d3d9b2f50ce680bca293eba7f0c3fc1d004ed2258fc839' ||
      !entry.isFile() || (entry.mode & 0o111) === 0) {
    throw fault('NODE_BINARY_MISMATCH', 'staged guest Node differs from pinned executable');
  }
  await copyFile(fileURLToPath(import.meta.url), join(runtime, 'qualify-muse-credential-relay.mjs'));
  await copyFile(resolve('scripts/experiment-worker-sandbox.mjs'), join(runtime, 'experiment-worker-sandbox.mjs'));
  await copyFile(resolve('scripts/qualify-muse-sandbox-transport.mjs'), join(runtime, 'qualify-muse-sandbox-transport.mjs'));
  return runtime;
}

export async function stageNativeRuntime(root, muse, stagePinned = stageRuntime) {
  const runtime = await stagePinned(root, muse);
  if (runtime !== join(root, 'runtime')) {
    throw fault('NATIVE_RUNTIME_STAGE_INVALID', 'pinned diagnostic staging returned another runtime path');
  }
  await copyFile(fileURLToPath(import.meta.url),
    join(runtime, 'qualify-muse-credential-relay.mjs'));
  return runtime;
}

export function relaySandboxConfig({ workspace, runtime, home, protectedRoot, socketDirectory }) {
  return { workspace, preserveWorkspacePath: true, denied: [protectedRoot], mounts: [
    { source: runtime, target: GUEST_RUNTIME, mode: 'ro' },
    { source: home, target: '/mounts/home', mode: 'rw' },
    { source: socketDirectory, target: '/mounts/relay', mode: 'ro' },
  ] };
}

function statIdentity(raw) {
  const pid = Number(/^([1-9]\d*) \(/.exec(raw)?.[1]);
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  const start = fields[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || !/^\d+$/.test(start ?? '')) {
    throw fault('STOP_IDENTITY_INVALID', 'process stat could not be verified');
  }
  return { pid, parent, state: fields[0], start };
}
async function inspectProcess(pid) {
  const base = `/proc/${pid}`;
  const [stat, exe, pidns, netns, status] = await Promise.all([
    readFile(`${base}/stat`, 'utf8'), readlink(`${base}/exe`), readlink(`${base}/ns/pid`),
    readlink(`${base}/ns/net`), readFile(`${base}/status`, 'utf8'),
  ]);
  const identity = statIdentity(stat);
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  if (identity.pid !== pid || ['Z', 'X'].includes(identity.state) || !nspid?.length ||
      nspid.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw fault('STOP_IDENTITY_INVALID', 'process identity or namespace PID changed');
  }
  return { ...identity, exe, pidns, netns, nspid };
}
async function membersOf(pidns) {
  const members = [];
  for (const entry of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let current;
    try { current = await readlink(`/proc/${entry}/ns/pid`); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (current === pidns) members.push(await inspectProcess(Number(entry)));
  }
  return members;
}

export async function captureFixtureProcesses(wrapperPid, statusChildPid, expectedNode) {
  const wrapper = await inspectProcess(wrapperPid);
  const statusChild = await inspectProcess(statusChildPid);
  if (wrapper.pidns === statusChild.pidns || wrapper.netns === statusChild.netns) {
    throw fault('STOP_ASSOCIATION_NAMESPACES', 'Bubblewrap child did not enter separate namespaces');
  }
  const fd = await open(`/proc/${statusChildPid}/ns/pid`, 'r');
  try {
    const pinned = await readlink(`/proc/self/fd/${fd.fd}`);
    if (pinned !== statusChild.pidns) throw fault('STOP_ASSOCIATION_PINNED', 'held namespace differs');
    const members = await membersOf(pinned);
    const node = members.filter(item => item.exe === `${GUEST_RUNTIME}/node`);
    const init = members.filter(item => item.nspid.at(-1) === 1);
    const sourceNode = await stat(expectedNode);
    const runningNode = node.length === 1 ? await stat(`/proc/${node[0].pid}/exe`) : null;
    if (node.length !== 1 || init.length !== 1 ||
        !members.some(item => item.pid === statusChildPid && item.start === statusChild.start) ||
        node[0].netns !== statusChild.netns || init[0].pid !== statusChildPid ||
        node[0].parent !== init[0].pid || !runningNode ||
        runningNode.dev !== sourceNode.dev || runningNode.ino !== sourceNode.ino) {
      throw Object.assign(fault('STOP_ASSOCIATION_MEMBERS', 'unique guest supervisor or namespace init absent'),
        { observation: { members: members.length, node: node.length, init: init.length,
          statusPresent: members.some(item => item.pid === statusChildPid && item.start === statusChild.start),
          netMatch: node.length === 1 && node[0].netns === statusChild.netns,
          initIsStatus: init.length === 1 && init[0].pid === statusChildPid,
          nodeParentIsInit: node.length === 1 && init.length === 1 && node[0].parent === init[0].pid,
          inodeMatch: !!runningNode && runningNode.dev === sourceNode.dev && runningNode.ino === sourceNode.ino } });
    }
    return { fd, pidns: pinned, wrapper, statusChild, members,
      boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
  } catch (error) { await fd.close(); throw error; }
}

export async function verifyFixtureStop(capture, status, exit, {
  bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'), scan = membersOf,
} = {}) {
  if (await bootId() !== capture.boot ||
      status.child !== capture.statusChild.pid || status.exit !== 0 ||
      exit.code !== 0 || exit.signal !== null || !exit.statusClosed || exit.timedOut || exit.overflow) {
    throw fault('STOP_STATUS_INVALID', 'Bubblewrap status or exit did not prove clean stop');
  }
  for (const observed of [capture.wrapper, ...capture.members]) {
    let stat;
    try { stat = statIdentity(await readStat(observed.pid)); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (stat.start !== observed.start) throw fault('STOP_PID_REUSED', 'observed PID was reused');
    throw fault('STOP_SURVIVOR', 'observed process remains');
  }
  if ((await scan(capture.pidns)).length !== 0) throw fault('STOP_SURVIVOR', 'guest namespace still has live members');
  return { kind: 'confirmed', observed: capture.members.length + 1 };
}

export async function qualify({ checkBubblewrap = probeBubblewrap, execute = executeGuest } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-credential-relay-'));
  // The exact copied Node executable is 116 MiB. Keep the tiny canonical
  // workspace under /tmp while staging only approved runtime bytes in tmpfs.
  let runtimeRoot;
  let upstream;
  let broker;
  let hostStarted = false;
  let stageName = 'prepare';
  let result;
  try {
    runtimeRoot = await mkdtemp('/dev/shm/passeur-muse-credential-relay-runtime-');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const socketDirectory = join(root, 'socket');
    await Promise.all([workspace, home, protectedRoot, socketDirectory].map(path => mkdir(path, { mode: 0o700 })));
    const marker = randomBytes(24);
    await writeFile(join(protectedRoot, 'marker'), marker);
    const markerEntry = await lstat(join(protectedRoot, 'marker'));
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(runtimeRoot);
    const runId = `run_${randomBytes(12).toString('hex')}`;
    const bearer = randomBytes(32).toString('hex');
    stageName = 'upstream';
    upstream = await fakeUpstream(bearer);
    const hostBefore = await tcpProbe('127.0.0.1', Number(new URL(upstream.origin).port));
    if (hostBefore.kind !== 'connected') throw fault('HOST_UPSTREAM_UNAVAILABLE', 'fake upstream unreachable before guest');
    stageName = 'broker';
    broker = await startBroker({ socketPath: join(socketDirectory, 'relay.sock'),
      upstreamOrigin: upstream.origin, runId, bearer });
    const config = relaySandboxConfig({ workspace, runtime, home, protectedRoot, socketDirectory });
    const prepared = prepareSandbox(config, [`${GUEST_RUNTIME}/node`,
      `${GUEST_RUNTIME}/qualify-muse-credential-relay.mjs`, '--guest']);
    checkBubblewrap();
    stageName = 'guest';
    hostStarted = true;
    const executed = await execute(prepared, { workspace, protectedRoot, runId,
      hostPort: Number(new URL(upstream.origin).port) }, join(runtime, 'node'));
    const hostAfter = await tcpProbe('127.0.0.1', Number(new URL(upstream.origin).port));
    if (hostAfter.kind !== 'connected') throw fault('HOST_UPSTREAM_UNAVAILABLE', 'fake upstream unreachable after guest');
    const markerAfter = await lstat(join(protectedRoot, 'marker'));
    if (!markerAfter.isFile() || markerAfter.dev !== markerEntry.dev || markerAfter.ino !== markerEntry.ino ||
        !marker.equals(await readFile(join(protectedRoot, 'marker')))) {
      throw fault('PROTECTED_MARKER_CHANGED', 'host-only protected marker changed');
    }
    let guest;
    try { guest = JSON.parse(executed.output); }
    catch { guest = { kind: 'guest_output_invalid' }; }
    const execution = { code: executed.code, signal: executed.signal ?? null,
      timedOut: executed.timedOut === true, overflow: executed.overflow === true,
      stopProof: executed.stopProof,
      guestKind: guest?.kind ?? null, guestCode: guest?.code ?? null };
    if (executed.code !== 0 || executed.timedOut || executed.overflow ||
        executed.stopProof?.kind !== 'confirmed' || guest.kind !== 'guest_relay_observed') {
      throw Object.assign(fault('GUEST_FAILED', 'guest fixture or exact stop failed'), { execution });
    }
    if (guest.kind !== 'guest_relay_observed' || upstream.seen.length !== 2 ||
        upstream.seen.some(item => !item.correctBearer || !item.dummyAbsent) ||
        broker.evidence.accepted !== 2) throw fault('RELAY_EVIDENCE_INVALID', 'relay evidence did not match fixture');
    result = { kind: 'synthetic_relay_observed', guest, broker: broker.evidence,
      upstream: upstream.seen, hostUpstream: { before: hostBefore.kind, after: hostAfter.kind },
      stopProof: 'fixture_processes_confirmed', stop: executed.stopProof };
    if (JSON.stringify(result).includes(bearer) || JSON.stringify(result).includes(marker.toString())) {
      throw fault('EVIDENCE_DISCLOSURE', 'synthetic secret entered retained evidence');
    }
  } catch (error) {
    result = { kind: 'synthetic_relay_error', stage: stageName, code: error.code ?? error.name,
      ...(error.execution ? { execution: error.execution } : {}),
      ...(broker ? { broker: broker.evidence } : {}),
      ...(upstream ? { upstream: upstream.seen } : {}),
      stopProof: 'descendants_unverified' };
  } finally {
    try { if (broker) await broker.close(); } catch { result.brokerClose = 'uncertain'; }
    try { if (upstream) await upstream.close(); } catch { result.upstreamClose = 'uncertain'; }
  }
  result.hostStarted = hostStarted;
  if (result.kind === 'synthetic_relay_observed' && !result.brokerClose && !result.upstreamClose) {
    const socket = join(root, 'socket', 'relay.sock');
    if (await lstat(socket).then(entry => entry.isSocket(), () => false)) {
      result.retainedFixtures = [root, runtimeRoot];
      result.socketStop = 'socket_path_still_present';
    } else {
      await rm(root, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      result.socketStop = 'observed_absent';
    }
  } else {
    if (result?.kind === 'native_synthetic_relay_observed') {
      result = { kind: 'native_synthetic_relay_error',
        primary: { stage: 'socket_retirement', code: 'SOCKET_STOP_UNVERIFIED' },
        stopProof, hostStarted };
    }
    result.retainedFixtures = [root, runtimeRoot].filter(Boolean);
  }
  return result;
}

export async function qualifyNativeRelay({
  muse = '/home/jeremy/.local/bin/muse', checkBubblewrap = probeBubblewrap,
  stagePinned = stageNativeRuntime, startSentinel = startHostSentinel,
  startUpstream = startNativeUpstream, startSocketBroker = startBroker,
  probe = tcpProbe, prepare = prepareSandbox,
  launch = runStatusPhase, capture = captureHostIdentities, stop = verifyHostStop,
  inspectSocket = lstat, validateReady = validateShellReady,
  validateOutcome = validateReadFileOutcome, inspectRetainedRoot = lstat,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-native-credential-relay-'));
  let runtimeRoot;
  let sentinel;
  let upstream;
  let broker;
  let host;
  let captured;
  let stopProof = { kind: 'unverified', code: 'NOT_ATTEMPTED' };
  let primary = null;
  let stageName = 'prepare';
  let observed = null;
  let hostStarted = false;
  const sourceFailures = { first: null };
  let rejectProvider;
  let rejectBroker;
  try {
    runtimeRoot = await mkdtemp('/dev/shm/passeur-muse-native-relay-runtime-');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const socketDirectory = join(root, 'socket');
    await Promise.all([workspace, home, protectedRoot, socketDirectory]
      .map(path => mkdir(path, { mode: 0o700 })));
    const canaryToken = `marker-${randomBytes(12).toString('hex')}`;
    const protectedContent = randomBytes(24).toString('hex');
    await writeFile(join(protectedRoot, canaryToken), protectedContent,
      { mode: 0o600, flag: 'wx' });
    const protectedEntry = await lstat(join(protectedRoot, canaryToken));
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const linkEntry = await lstat(join(workspace, 'protected-link'));
    const canary = readFileCanaryFixture();
    if (Object.keys(canary).sort().join(',') !== 'content,name' ||
        typeof canary.name !== 'string' || typeof canary.content !== 'string') {
      throw fault('READ_CANARY_FIXTURE_INVALID', 'reviewed read canary contract unavailable');
    }
    await writeFile(join(workspace, canary.name), canary.content,
      { mode: 0o600, flag: 'wx' });
    stageName = 'runtime';
    const runtime = await settleWithin(stagePinned(runtimeRoot, muse), 30_000,
      'NATIVE_STAGE_DEADLINE');
    stageName = 'host_fixtures';
    sentinel = await startSentinel();
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host TCP sentinel unavailable');
    }
    const runId = `run_${randomBytes(12).toString('hex')}`;
    const bearer = randomBytes(32).toString('hex');
    upstream = await startUpstream({ bearer, workspace, protectedRoot,
      canaryToken, hostPort: sentinel.port });
    broker = await startSocketBroker({ socketPath: join(socketDirectory, 'relay.sock'),
      upstreamOrigin: upstream.origin, runId, bearer, profile: 'native-read', workspace });
    const noteSourceFailure = (source, code) => {
      const observedFailure = { source, code: boundedCode({ code }) };
      sourceFailures.first ??= observedFailure;
      return fault(observedFailure.code, `${source} rejected native traffic`);
    };
    rejectProvider = upstream.provider.rejection.then(event => {
      throw noteSourceFailure('provider', event.code);
    });
    rejectProvider.catch(() => undefined);
    rejectBroker = (broker.failure ?? new Promise(() => undefined)).then(event => {
      throw noteSourceFailure('broker', event.code);
    });
    rejectBroker.catch(() => undefined);
    const prepared = prepare(relaySandboxConfig({ workspace, runtime, home,
      protectedRoot, socketDirectory }), [`${GUEST_RUNTIME}/node`,
      `${GUEST_RUNTIME}/qualify-muse-credential-relay.mjs`, '--guest-native']);
    checkBubblewrap();
    stageName = 'guest_ready';
    hostStarted = true;
    host = launch(prepared, { phase: 'read-file-probe', workspace, protectedRoot,
      canaryToken, hostPort: sentinel.port, runId });
    const [ready, liveStatus] = await Promise.all([
      Promise.race([host.ready, rejectProvider, rejectBroker]), host.liveStatus,
    ]);
    const readyRequests = structuredClone(upstream.provider.requests);
    validateReady({ ...ready, providerRequests: readyRequests }, workspace, sentinel.port);
    if (ready.readCanarySha256 !== createHash('sha256').update(canary.content).digest('hex') ||
        ready.commandSha256 !== createHash('sha256').update(
          shellProbeCommand(workspace, protectedRoot, canaryToken)).digest('hex') ||
        liveStatus.child === null || liveStatus.exit !== null ||
        upstream.provider.state.primaryCode ||
        readyRequests.some(request => request.path === '/responses')) {
      throw fault('NATIVE_RELAY_READY_INVALID', 'native relay readiness or catalog differed');
    }
    captured = await settleWithin(capture(host.pid, liveStatus.child, ready.nativeIdentity.start,
      `${GUEST_RUNTIME}/muse-bin-1.4.0-R4302.1`, `${GUEST_RUNTIME}/node`),
    5_000, 'NATIVE_CAPTURE_DEADLINE');
    if (captured.native.nspid.at(-1) !== ready.nativeIdentity.pid ||
        captured.native.netns !== ready.nativeNamespace ||
        captured.supervisor.netns !== ready.guestNamespace) {
      throw fault('NATIVE_RELAY_IDENTITY_INVALID', 'host process tree differed from guest identity');
    }
    stageName = 'native_turn';
    host.releaseTurn();
    const outcome = await Promise.race([host.outcome, rejectProvider, rejectBroker]);
    if (outcome.kind === 'guest_transport_error') {
      throw fault(outcome.code, 'native guest reported a bounded transport failure');
    }
    if (outcome.kind !== 'native_read_file_outcome' || upstream.provider.state.primaryCode) {
      throw fault(upstream.provider.state.primaryCode ?? 'NATIVE_RELAY_OUTCOME_INVALID',
        'native guest outcome or provider rejection differed');
    }
    stageName = 'freeze';
    if (upstream.provider.state.active !== 0) {
      throw fault('NATIVE_PROVIDER_ACTIVE', 'host provider still has admitted request');
    }
    await settleWithin(broker.close(), 5_000, 'BROKER_CLOSE_DEADLINE');
    await settleWithin(upstream.provider.freeze(), 5_000, 'PROVIDER_FREEZE_DEADLINE');
    if (broker.evidence.firstFailure) {
      throw fault(broker.evidence.firstFailure.code, 'host broker first refusal remained after closure');
    }
    const finalRequests = structuredClone(upstream.provider.requests);
    if (upstream.provider.state.primaryCode || broker.evidence.rejected !== 0 ||
        broker.evidence.accepted !== finalRequests.length ||
        upstream.seen.length !== finalRequests.length ||
        upstream.seen.some(item => !item.correctBearer || !item.dummyAbsent) ||
        JSON.stringify(finalRequests.slice(0, readyRequests.length)) !== JSON.stringify(readyRequests)) {
      throw fault('NATIVE_RELAY_PROVIDER_INVALID', 'host provider or synthetic bearer evidence differed');
    }
    stageName = 'native_shutdown';
    host.releaseShutdown();
    const finished = await settleWithin(host.finished, 30_000, 'NATIVE_HOST_EXIT_DEADLINE');
    const status = parseBubblewrapStatus(finished.statusLines);
    stopProof = await settleWithin(stop(captured, status, finished), 5_000,
      'NATIVE_STOP_DEADLINE');
    await captured.fd.close(); captured = undefined;
    if (stopProof.kind !== 'confirmed' || finished.output.length !== 3 ||
        finished.code !== 0 || finished.timedOut || finished.overflow ||
        JSON.stringify(JSON.parse(finished.output[2])) !== JSON.stringify(outcome)) {
      throw fault('NATIVE_RELAY_STOP_INVALID', 'native final result or exact stop differed');
    }
    if (upstream.provider.state.primaryCode) {
      throw fault(upstream.provider.state.primaryCode,
        'host provider rejected after native shutdown release');
    }
    const classified = validateOutcome(
      { ...ready, providerRequests: readyRequests },
      { ...outcome, providerRequests: finalRequests }, workspace);
    const protectedAfter = await lstat(join(protectedRoot, canaryToken));
    const linkAfter = await lstat(join(workspace, 'protected-link'));
    if (!protectedAfter.isFile() || protectedAfter.dev !== protectedEntry.dev ||
        protectedAfter.ino !== protectedEntry.ino ||
        !linkAfter.isSymbolicLink() || linkAfter.dev !== linkEntry.dev ||
        linkAfter.ino !== linkEntry.ino ||
        await readlink(join(workspace, 'protected-link')) !== protectedRoot ||
        await readFile(join(protectedRoot, canaryToken), 'utf8') !== protectedContent ||
        await readFile(join(workspace, canary.name), 'utf8') !== canary.content ||
        (await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('NATIVE_RELAY_CANARY_INVALID', 'host-only or workspace canary changed');
    }
    observed = { kind: 'native_synthetic_relay_observed', classified,
      broker: broker.evidence, upstream: upstream.seen,
      stopProof: { kind: stopProof.kind, observed: stopProof.observed },
      hostStarted: true };
    if (JSON.stringify(observed).includes(bearer) ||
        JSON.stringify(observed).includes(protectedContent)) {
      throw fault('EVIDENCE_DISCLOSURE', 'synthetic secret entered native evidence');
    }
  } catch (error) {
    const reported = boundedCode(error);
    const providerCode = upstream?.provider?.state?.primaryCode;
    const brokerCode = broker?.evidence?.firstFailure?.code;
    const firstSource = sourceFailures.first ?? (providerCode && !brokerCode ?
      { source: 'provider', code: providerCode } : brokerCode && !providerCode ?
        { source: 'broker', code: brokerCode } : null);
    primary = { stage: stageName,
      code: firstSource?.code ?? (providerCode && brokerCode ? 'SOURCE_ORDER_UNVERIFIED' : reported),
      ...(firstSource ? { source: firstSource.source } : {}) };
    if (primary.code !== reported) primary.secondary = reported;
    if (providerCode && providerCode !== primary.code) primary.providerCode = providerCode;
    if (brokerCode && brokerCode !== primary.code) primary.brokerCode = brokerCode;
  } finally {
    if (host && stopProof.kind !== 'confirmed') {
      try { host.abort(); }
      catch { primary ??= { stage: 'host_abort', code: 'NATIVE_HOST_ABORT_UNVERIFIED' }; }
      const finished = await settleWithin(host.finished, 5_000, 'NATIVE_HOST_EXIT_DEADLINE')
        .catch(() => null);
      if (captured && finished) {
        try { stopProof = await settleWithin(stop(captured,
          parseBubblewrapStatus(finished.statusLines), finished), 5_000, 'NATIVE_STOP_DEADLINE'); }
        catch (error) { stopProof = { kind: 'unverified', code: boundedCode(error) }; }
      }
    }
    if (captured) await captured.fd.close().catch(() => undefined);
    try { if (broker?.listening) await settleWithin(broker.close(), 5_000, 'BROKER_CLOSE_DEADLINE'); }
    catch { primary ??= { stage: 'broker_close', code: 'SOCKET_STOP_UNVERIFIED' }; }
    try { if (broker?.flushCapture) await settleWithin(broker.flushCapture(), 5_000, 'BROKER_CAPTURE_DEADLINE'); }
    catch (error) {
      broker?.cancelCapture?.(boundedCode(error));
      primary ??= { stage: 'broker_capture', code: 'BROKER_CAPTURE_UNVERIFIED' };
    }
    try { if (upstream) await settleWithin(upstream.close(), 5_000, 'UPSTREAM_CLOSE_DEADLINE'); }
    catch { primary ??= { stage: 'upstream_close', code: 'UPSTREAM_STOP_UNVERIFIED' }; }
    try { if (sentinel) await settleWithin(sentinel.close(), 5_000, 'SENTINEL_CLOSE_DEADLINE'); }
    catch { primary ??= { stage: 'sentinel_close', code: 'SENTINEL_STOP_UNVERIFIED' }; }
  }
  let result = primary ? { kind: 'native_synthetic_relay_error', primary,
    stopProof, hostStarted, ...(broker ? { broker: structuredClone(broker.evidence) } : {}) } : observed;
  if (result?.kind === 'native_synthetic_relay_observed') {
    let socketAbsent = false;
    try { await inspectSocket(join(root, 'socket', 'relay.sock')); }
    catch (error) {
      if (error?.code === 'ENOENT') socketAbsent = true;
      else result = { kind: 'native_synthetic_relay_error',
        primary: { stage: 'retirement', code: 'SOCKET_INSPECTION_UNVERIFIED',
          secondary: boundedCode(error) }, stopProof, hostStarted,
        retainedFixtures: [root, runtimeRoot] };
    }
    if (!socketAbsent && result.kind === 'native_synthetic_relay_observed') {
      result = { kind: 'native_synthetic_relay_error',
        primary: { stage: 'retirement', code: 'SOCKET_STILL_PRESENT' },
        stopProof, hostStarted, retainedFixtures: [root, runtimeRoot] };
    }
    if (socketAbsent) {
    try {
      await rm(root, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      result.socketStop = 'observed_absent';
    } catch (error) {
      result = { kind: 'native_synthetic_relay_error',
        primary: { stage: 'retirement', code: boundedCode(error) },
        stopProof, hostStarted,
        retainedFixtures: (await Promise.all([root, runtimeRoot].map(async path =>
          await lstat(path).then(() => path, () => null)))).filter(Boolean) };
    }
    }
  }
  if (result.kind === 'native_synthetic_relay_error') {
    result.retainedRoots = await Promise.all([root, runtimeRoot].filter(Boolean).map(async path => {
      try { await inspectRetainedRoot(path); return { path, status: 'present' }; }
      catch (error) { return { path, status: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
        ...(error?.code === 'ENOENT' ? {} : { code: boundedCode(error) }) }; }
    }));
    result.retainedFixtures = result.retainedRoots.filter(item => item.status === 'present')
      .map(item => item.path);
  }
  return result;
}

async function executeGuest(prepared, config, expectedNode) {
  const separator = prepared.args.indexOf('--');
  if (separator < 0) throw fault('BWRAP_STATUS_INVALID', 'missing command delimiter');
  const args = [...prepared.args.slice(0, separator), '--json-status-fd', '3', ...prepared.args.slice(separator)];
  const child = spawn(prepared.executable, args, { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let output = '';
  let stderrBytes = 0;
  let overflow = false;
  let timedOut = false;
  let statusClosed = false;
  let statusCloseResolve;
  const statusDone = new Promise(resolveValue => { statusCloseResolve = resolveValue; });
  const statusLines = [];
  let statusBuffer = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveValue, reject) => { readyResolve = resolveValue; readyReject = reject; });
  ready.catch(() => undefined);
  const closed = new Promise(resolveValue => child.once('close', (code, signal) => resolveValue({ code, signal })));
  closed.then(() => readyReject(fault('GUEST_EXIT_EARLY', 'guest exited before ready')));
  child.once('error', error => readyReject(error));
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGTERM'); } catch { /* retain uncertainty */ }
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGKILL'); } catch { /* retain uncertainty */ }
    }, 1_000).unref();
  };
  const timer = setTimeout(() => { timedOut = true; readyReject(fault('GUEST_DEADLINE', 'guest fixture timed out')); stop(); }, RUN_MS);
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
      overflow = true; readyReject(fault('GUEST_OUTPUT_LIMIT', 'guest output exceeded bound')); stop(); return;
    }
    const line = output.split('\n')[0];
    if (output.includes('\n')) {
      try { readyResolve(JSON.parse(line)); } catch { readyReject(fault('GUEST_OUTPUT_INVALID', 'guest output invalid')); }
    }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length;
    if (stderrBytes > OUTPUT_LIMIT) { overflow = true; readyReject(fault('GUEST_OUTPUT_LIMIT', 'guest stderr exceeded bound')); stop(); }
  });
  child.stdio[3].on('data', chunk => {
    statusBuffer += chunk.toString();
    if (Buffer.byteLength(statusBuffer) > OUTPUT_LIMIT) { overflow = true; stop(); return; }
    while (statusBuffer.includes('\n')) {
      const index = statusBuffer.indexOf('\n');
      statusLines.push(statusBuffer.slice(0, index));
      statusBuffer = statusBuffer.slice(index + 1);
    }
  });
  child.stdio[3].once('close', () => { statusClosed = true; statusCloseResolve(); });
  child.stdin.write(`${JSON.stringify(config)}\n`);
  let capture;
  let stopProof;
  try {
    const guest = await ready;
    if (guest.kind !== 'guest_relay_observed') throw fault('GUEST_FAILED', 'guest relay did not observe expected result');
    const deadline = Date.now() + 2_000;
    let status;
    do {
      status = parseBubblewrapStatus(statusLines);
      if (status.child !== null) break;
      await new Promise(resolveValue => setTimeout(resolveValue, 10));
    } while (Date.now() < deadline);
    if (status.child === null) throw fault('BWRAP_STATUS_INVALID', 'guest child PID not reported');
    capture = await captureFixtureProcesses(child.pid, status.child, expectedNode);
    child.stdin.end('release\n');
    const exit = await settleWithin(closed, 5_000, 'GUEST_STOP_DEADLINE');
    await settleWithin(statusDone, 1_000, 'STATUS_CLOSE_DEADLINE');
    status = parseBubblewrapStatus(statusLines);
    stopProof = await verifyFixtureStop(capture, status, { ...exit, statusClosed, timedOut, overflow });
    return { ...exit, output: output.trim(), timedOut, overflow, stopProof };
  } catch (error) {
    stop();
    const exit = await settleWithin(closed, 3_000, 'GUEST_STOP_DEADLINE')
      .catch(() => ({ code: null, signal: null }));
    return { ...exit, output: output.trim(), timedOut, overflow,
      stopProof: { kind: 'unverified', code: error.code ?? error.name,
        ...(error.observation ? { observation: error.observation } : {}) } };
  } finally {
    clearTimeout(timer);
    if (capture) await capture.fd.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--guest-native') {
    const lines = createInterface({ input: process.stdin });
    const iterator = lines[Symbol.asyncIterator]();
    let normalEnd = false;
    let releaseCount = 0;
    let rejectCaller;
    const callerFailure = new Promise((_, reject) => { rejectCaller = reject; });
    callerFailure.catch(() => undefined);
    lines.on('line', line => {
      if (line === 'shutdown' && releaseCount === 2) normalEnd = true;
      else if (line === 'shutdown') rejectCaller(fault('HOST_RELEASE_INVALID', 'early shutdown line'));
    });
    lines.once('close', () => {
      if (!normalEnd) rejectCaller(fault('HOST_CHANNEL_CLOSED', 'guest host control channel closed'));
    });
    const release = async () => {
      if (++releaseCount > 2) throw fault('HOST_RELEASE_INVALID', 'extra native release requested');
      const line = await iterator.next();
      if (line.done) throw fault('HOST_CHANNEL_CLOSED', 'guest host control channel closed');
      if (releaseCount === 2 && line.value === 'shutdown') normalEnd = true;
      return line.value;
    };
    try {
      const first = await iterator.next();
      if (first.done || Buffer.byteLength(first.value) > OUTPUT_LIMIT) {
        throw fault('GUEST_INPUT_LIMIT', 'native guest config missing or too large');
      }
      const config = JSON.parse(first.value);
      process.stdout.write(`${JSON.stringify(await guestNativeFixture(config,
        { release, callerFailure }))}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_transport_error', stage: 'native_turn',
        code: boundedCode(error) === 'UNCLASSIFIED_ERROR' ? 'NATIVE_RELAY_ERROR' : boundedCode(error),
        message: 'native relay guest failed', providerRequests: [] })}\n`);
      process.exitCode = 1;
    }
  } else if (process.argv[2] === '--guest') {
    try {
      const lines = createInterface({ input: process.stdin });
      const iterator = lines[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || Buffer.byteLength(first.value) > OUTPUT_LIMIT) throw fault('GUEST_INPUT_LIMIT', 'guest config missing or too large');
      process.stdout.write(`${JSON.stringify(await guestFixture(JSON.parse(first.value)))}\n`);
      const release = await iterator.next();
      if (release.done || release.value !== 'release') throw fault('GUEST_RELEASE_INVALID', 'guest release was not exact');
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_relay_error', code: error.code ?? error.name })}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stdout.write(`${JSON.stringify(process.argv[2] === '--native' ?
      await qualifyNativeRelay() : await qualify())}\n`);
  }
}
