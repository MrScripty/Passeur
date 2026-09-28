#!/usr/bin/env node
// Disposable, no-account transport probe. The guest path runs only inside Bubblewrap.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, readdir, symlink, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { prepareSandbox, probeBubblewrap } from './experiment-worker-sandbox.mjs';

const VERSION = '1.4.0-R4302.1';
const NATIVE_SHA256 = 'ad21c22965f8600b4473b4ab8354ff7cc483d4cb681b46f2952561d855c8ed86';
const SDK_VERSION = '1.3.0';
const NODE_VERSION = 'v24.12.0';
const NODE_SHA256 = '16143bdaa79716e871d3d9b2f50ce680bca293eba7f0c3fc1d004ed2258fc839';
const MODEL = 'fixture-transport-only';
const LIMIT = 65_536;
const PROVIDER_INPUT_LIMIT = 262_144;
const APPROVAL_LOG_LIMIT = 1_048_576;
const DEADLINE_MS = 25_000;
const HELD_WAIT_MS = 600_000;
const HELD_INPUT_MS = HELD_WAIT_MS - 10_000;
const HELD_DEADLINE_MS = HELD_WAIT_MS + 60_000;
const GUEST_RUNTIME = '/mounts/runtime';
const GUEST_HOME = '/mounts/home';
const SHELL_MODEL = 'fixture-native-shell';
const SHELL_RESPONSE = 'resp_native_shell_1';
const SHELL_TEXT_RESPONSE = 'resp_native_shell_2';
const SHELL_ITEM = 'fc_native_shell_1';
const SHELL_CALL = 'call_native_shell_1';
const REMINDER_RESPONSE = 'resp_native_reminder_1';
const REMINDER_ITEM = 'fc_native_reminder_1';
const REMINDER_CALL = 'call_native_reminder_1';
const REMINDER_PAYLOAD = Object.freeze({ advisory_text: null, confidence: 'low', decision: 'none',
  priority: 'normal', reason: 'Disposable scripted protocol probe; no skill reminder is being proposed.',
  skill_id: null, visible_for_steps: 1 });

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function timeout(stage, promise, ms = DEADLINE_MS) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fault('PROBE_DEADLINE', `${stage} exceeded ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function pinnedBinary(muse, { canonicalize = realpath, hash = digest } = {}) {
  const launcher = await canonicalize(muse);
  const native = join(dirname(launcher), `muse-bin-${VERSION}`);
  if (await canonicalize(native) !== native || await hash(native) !== NATIVE_SHA256) {
    throw fault('NATIVE_BINARY_MISMATCH', 'installed Muse binary path or digest differs from pinned identity');
  }
  return native;
}

export async function pinnedNode(executable = process.execPath, {
  canonicalize = realpath, hash = digest, version = process.version,
} = {}) {
  if (version !== NODE_VERSION) throw fault('NODE_BINARY_MISMATCH', 'host Node version differs from pinned guest runtime');
  const node = await canonicalize(executable);
  if (node !== executable || await hash(node) !== NODE_SHA256) {
    throw fault('NODE_BINARY_MISMATCH', 'host Node path or digest differs from pinned guest runtime');
  }
  return node;
}

export function guestEnvironment() {
  return { HOME: GUEST_HOME, XDG_CONFIG_HOME: `${GUEST_HOME}/.config`,
    XDG_DATA_HOME: `${GUEST_HOME}/.local/share`, XDG_CACHE_HOME: `${GUEST_HOME}/.cache`,
    TMPDIR: '/tmp', PATH: '/usr/bin:/bin', MUSE_NO_AUTO_UPDATE: '1', LANG: 'C.UTF-8' };
}

export function sandboxConfig({ workspace, runtime, home, protectedRoot }) {
  return { workspace, preserveWorkspacePath: true, denied: [protectedRoot], mounts: [
    { source: runtime, target: GUEST_RUNTIME, mode: 'ro' },
    { source: home, target: GUEST_HOME, mode: 'rw' },
  ] };
}

export function guestCommand() {
  return [`${GUEST_RUNTIME}/node`, `${GUEST_RUNTIME}/qualify-muse-sandbox-transport.mjs`, '--guest'];
}

export function assertPortSeparation(hostPort, guestPort) {
  if (!Number.isSafeInteger(hostPort) || !Number.isSafeInteger(guestPort) ||
      hostPort < 1 || guestPort < 1 || hostPort > 65535 || guestPort > 65535 || hostPort === guestPort) {
    throw fault('PORT_SEPARATION_INVALID', 'host sentinel and guest provider require distinct valid ports');
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function startHostSentinel() {
  const nonce = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16);
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/sentinel' ? 200 : 404, { 'content-type': 'text/plain' });
    response.end(request.url === '/sentinel' ? nonce : 'missing');
  });
  const port = await listen(server);
  return { port, nonce, close: () => close(server) };
}

export async function startGuestProvider(forbiddenPort) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let bytes = 0;
    let body = '';
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > LIMIT) throw fault('REQUEST_TOO_LARGE', 'fixture request exceeds limit');
        body += chunk;
      }
    } catch {
      response.writeHead(413).end();
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* catalog GET has no JSON body */ }
    requests.push({ method: request.method, path: request.url, bytes,
      directMarker: request.url === '/responses' && parsed?.input === 'transport only' });
    if (request.method === 'GET' && request.url === '/muse-code/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', metadata: {
        'muse-code': { release_date: '2026-01-01', is_hidden: false,
          limit: { context: 1_000_000, output: 1024 } },
      } }] }));
    } else if (request.method === 'POST' && request.url === '/responses') {
      // Direct client text only. A native model turn is never submitted by this probe.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp_transport', object: 'response', model: MODEL,
        status: 'completed', output: [{ type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: 'Fixture transport only.' },
        ] }] }));
    } else {
      response.writeHead(501, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unsupported fixture path' } }));
    }
  });
  const port = await listen(server);
  try { assertPortSeparation(forbiddenPort, port); }
  catch (error) { await close(server); throw error; }
  return { port, requests, close: () => close(server) };
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export function shellProbeCommand(workspace, protectedRoot, token) {
  const direct = join(protectedRoot, token);
  const linked = join(workspace, 'protected-link', token);
  const proc = `/proc/1/root${direct}`;
  return [
    `cd ${shellQuote(workspace)}`,
    "printf native-write > shell-canary",
    "if [ \"$(cat shell-canary)\" = native-write ]; then printf 'workspace=ok\\n'; else printf 'workspace=failed\\n'; fi",
    ...[['direct', direct], ['symlink', linked], ['proc', proc]].map(([label, path]) =>
      `if [ -e ${shellQuote(path)} ] || (printf forbidden > ${shellQuote(path)} 2>/dev/null); then printf '${label}=visible\\n'; else printf '${label}=denied\\n'; fi`),
    `if [ -r ${shellQuote(`${GUEST_HOME}/.config/muse/auth.json`)} ]; then printf 'dummy-auth=visible\\n'; else printf 'dummy-auth=absent\\n'; fi`,
  ].join('; ');
}

// Rejection evidence describes structure only. Values such as prompts, descriptions,
// tool arguments and credentials must never enter retained provider summaries.
export function rejectedToolSchemaShape(body) {
  const primitive = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const known = new Set(['type', 'name', 'function', 'parameters', 'properties', 'required',
    'additionalProperties', 'description', 'title', 'strict', 'command', 'not', 'allOf',
    'anyOf', 'oneOf', 'enum', 'const', 'items', 'minLength', 'maxLength', 'pattern',
    'minProperties', 'maxProperties', 'default', 'format', 'schema', 'input_schema',
    'inputSchema', 'arguments', 'args', 'options', 'capabilities', 'aliases',
    'examples', 'input_examples', 'inputExamples', 'variants', 'functions',
    'tools', 'subtools', 'commands', 'actions', 'methods', 'operations', 'members']);
  const shellNames = new Set(['bash', 'tool.bash', 'functions.bash', 'shell', 'tool.shell',
    'functions.shell', 'terminal', 'exec_command', 'run_shell_command', 'muse']);
  const toolTypes = new Set(['function', 'custom', 'shell', 'bash', 'muse', 'group', 'namespace']);
  const safeKey = key => known.has(key) ? key : '[other]';
  const fields = value => value && typeof value === 'object' && !Array.isArray(value) ?
    Object.entries(value).slice(0, 24).map(([key, item]) => [safeKey(key), primitive(item)]) : [];
  const nameShape = name => ({ nameClass: shellNames.has(name) ? name : 'other',
    nameLength: typeof name === 'string' ? Buffer.byteLength(name) : null,
    nameSha256: typeof name === 'string' && !shellNames.has(name) ?
      createHash('sha256').update(name).digest('hex') : null });
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const shape = { toolCount: tools.length, omitted: { tools: Math.max(0, tools.length - 8),
    properties: 0, fields: 0, required: 0, arrays: 0, arrayEntries: 0 }, tools: [] };
  shape.tools = tools.slice(0, 8).map((tool, index) => {
    const name = tool?.name ?? tool?.function?.name;
    const classifiedName = nameShape(name);
    const parameters = tool?.parameters ?? tool?.function?.parameters;
    const properties = parameters?.properties;
    const entries = properties && typeof properties === 'object' && !Array.isArray(properties) ?
      Object.entries(properties) : [];
    const arrayFields = tool && typeof tool === 'object' && !Array.isArray(tool) ?
      Object.entries(tool).filter(([, value]) => Array.isArray(value)) : [];
    shape.omitted.arrays += Math.max(0, arrayFields.length - 2);
    shape.omitted.arrayEntries += arrayFields.slice(0, 2).reduce((count, [, value]) =>
      count + Math.max(0, value.length - 4), 0);
    shape.omitted.fields += arrayFields.slice(0, 2).reduce((count, [, value]) => count +
      value.slice(0, 4).reduce((entryCount, entry) => entryCount +
        Math.max(0, Object.keys(entry ?? {}).length - 12), 0), 0);
    shape.omitted.properties += Math.max(0, entries.length - 16);
    shape.omitted.fields += Math.max(0, Object.keys(tool ?? {}).length - 24) +
      Math.max(0, Object.keys(parameters ?? {}).length - 24) +
      entries.slice(0, 16).reduce((count, [, value]) => count +
        Math.max(0, Object.keys(value ?? {}).length - 24), 0);
    shape.omitted.required += Math.max(0, (parameters?.required?.length ?? 0) - 16);
    return { index, bashName: name === 'bash',
      toolNameClass: classifiedName.nameClass,
      toolNameLength: classifiedName.nameLength,
      toolNameSha256: classifiedName.nameSha256,
      toolTypeClass: toolTypes.has(tool?.type) ? tool.type : 'other',
      toolFields: fields(tool), parameterFields: fields(parameters),
      arrayFields: arrayFields.slice(0, 2).map(([key, value]) => ({ key: safeKey(key), count: value.length,
        entries: value.slice(0, 4).map(entry => {
          const nestedParameters = entry?.parameters ?? entry?.function?.parameters;
          const nestedProperties = nestedParameters?.properties;
          const nestedEntries = nestedProperties && typeof nestedProperties === 'object' &&
            !Array.isArray(nestedProperties) ? Object.entries(nestedProperties) : [];
          shape.omitted.properties += Math.max(0, nestedEntries.length - 8);
          shape.omitted.required += Math.max(0, (nestedParameters?.required?.length ?? 0) - 8);
          shape.omitted.fields += Math.max(0, Object.keys(nestedParameters ?? {}).length - 12) +
            nestedEntries.slice(0, 8).reduce((count, [, property]) => count +
              Math.max(0, Object.keys(property ?? {}).length - 8), 0);
          return { ...nameShape(entry?.name ?? entry?.function?.name),
            typeClass: toolTypes.has(entry?.type) ? entry.type : 'other',
            fields: fields(entry).slice(0, 12), parameterFields: fields(nestedParameters).slice(0, 12),
            propertyCount: nestedEntries.length,
            properties: nestedEntries.slice(0, 8).map(([name, property]) =>
              ({ name: safeKey(name), fields: fields(property).slice(0, 8) })),
            required: Array.isArray(nestedParameters?.required) ?
              nestedParameters.required.slice(0, 8).map(value =>
                typeof value === 'string' ? safeKey(value) : primitive(value)) : null };
        }) })),
      propertyCount: entries.length,
      properties: entries.slice(0, 16).map(([key, value]) =>
        ({ name: safeKey(key), fields: fields(value) })),
      required: Array.isArray(parameters?.required) ?
        parameters.required.slice(0, 16).map(value => typeof value === 'string' ? safeKey(value) : primitive(value)) : null };
  });
  // Reserve most of the line budget for readiness, completion and the guest envelope.
  while (Buffer.byteLength(JSON.stringify(shape)) > 4_096) {
    const tool = shape.tools.at(-1);
    if (!tool) break;
    const array = tool.arrayFields.at(-1);
    const entry = array?.entries.at(-1);
    if (entry?.properties.length) { entry.properties.pop(); shape.omitted.properties++; }
    else if (entry?.required?.length) { entry.required.pop(); shape.omitted.required++; }
    else if (entry?.parameterFields.length) { entry.parameterFields.pop(); shape.omitted.fields++; }
    else if (entry?.fields.length) { entry.fields.pop(); shape.omitted.fields++; }
    else if (array?.entries.length) { array.entries.pop(); shape.omitted.arrayEntries++; }
    else if (tool.arrayFields.length) { tool.arrayFields.pop(); shape.omitted.arrays++; }
    else if (tool.properties.length) { tool.properties.pop(); shape.omitted.properties++; }
    else if (tool.required?.length) { tool.required.pop(); shape.omitted.required++; }
    else if (tool.parameterFields.length) { tool.parameterFields.pop(); shape.omitted.fields++; }
    else if (tool.toolFields.length) { tool.toolFields.pop(); shape.omitted.fields++; }
    else { shape.tools.pop(); shape.omitted.tools++; }
  }
  return shape;
}

export function summarizedShellModel(value) { return value === SHELL_MODEL ? SHELL_MODEL : 'invalid'; }

// The native reminder function is a distinct model-side prelude. Until its
// complete contract is known, observe its schema and emit no function result.
export function recognizedReminderSchema(body) {
  if (body?.model !== SHELL_MODEL) return null;
  const namespace = body?.tools?.length === 1 ? body.tools[0] : null;
  const functionTool = namespace?.tools?.length === 1 ? namespace.tools[0] : null;
  if (namespace?.type !== 'namespace' || namespace.name !== 'muse' ||
      functionTool?.type !== 'function' || functionTool.name !== 'submit_reminder_decision') return null;
  const parameters = functionTool.parameters;
  if (parameters?.type !== 'object' || !parameters.properties ||
      Array.isArray(parameters.properties) || typeof parameters.properties !== 'object' ||
      Object.keys(parameters.properties).length !== 7 || !Array.isArray(parameters.required) ||
      parameters.required.length !== 7) throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'reminder schema shape differs');
  const safeName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value);
  const names = Object.keys(parameters.properties);
  if (names.some(name => !safeName(name)) || parameters.required.some(name => !safeName(name)) ||
      new Set(parameters.required).size !== 7 || parameters.required.some(name => !names.includes(name))) {
    throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'reminder property names or required list differ');
  }
  const allowedTypes = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array', 'null']);
  const typeShape = schema => {
    const direct = Array.isArray(schema?.type) ? schema.type : [schema?.type];
    const alternatives = Array.isArray(schema?.anyOf) ? schema.anyOf :
      Array.isArray(schema?.oneOf) ? schema.oneOf : [];
    const observed = [...direct, ...alternatives.flatMap(branch =>
      Array.isArray(branch?.type) ? branch.type : [branch?.type])];
    const types = [...new Set(observed.filter(type => allowedTypes.has(type)))];
    return { types: types.length && types.length <= 3 ? types : ['unresolved'],
      nullable: types.includes('null') || schema?.nullable === true };
  };
  const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'minItems', 'maxItems'];
  const properties = names.map(name => {
    const schema = parameters.properties[name];
    const { types, nullable } = typeShape(schema);
    const enumValues = schema?.enum;
    if (enumValues !== undefined && (!Array.isArray(enumValues) || enumValues.length > 8 ||
        enumValues.some(value => value !== null && typeof value !== 'boolean' &&
          !(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000) &&
          !(typeof value === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(value))))) {
      throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'reminder enum cannot be retained safely');
    }
    const observedBounds = {};
    for (const key of bounds) if (Object.hasOwn(schema, key)) {
      const value = schema[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
        throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'reminder bound cannot be retained safely');
      }
      observedBounds[key] = value;
    }
    return { name, types, nullable, ...(enumValues === undefined ? {} : { enum: enumValues }),
      bounds: observedBounds };
  });
  const result = { namespace: 'muse', function: 'submit_reminder_decision', required: parameters.required,
    additionalProperties: parameters.additionalProperties === false ? false : 'unspecified', properties };
  if (Buffer.byteLength(JSON.stringify(result)) > 4_096) {
    throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'reminder schema exceeds retained evidence budget');
  }
  return result;
}

export function fixedNoReminderPayload(body) {
  const observed = recognizedReminderSchema(body);
  const namespace = body?.tools?.[0];
  const functionTool = namespace?.tools?.[0];
  const parameters = functionTool?.parameters;
  const onlyKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
  const reviewedTypes = { advisory_text: ['null', 'string'], confidence: ['null', 'string'],
    decision: 'string', priority: ['null', 'string'], reason: 'string', skill_id: ['null', 'string'],
    visible_for_steps: ['null', 'integer'] };
  if (!onlyKeys(namespace, ['type', 'name', 'description', 'tools']) ||
      !onlyKeys(functionTool, ['type', 'name', 'description', 'parameters', 'strict']) ||
      !onlyKeys(parameters, ['type', 'properties', 'required', 'additionalProperties',
        'description', 'title']) ||
      Object.entries(reviewedTypes).some(([name, type]) =>
        JSON.stringify(parameters.properties[name]?.type) !== JSON.stringify(type) ||
        Object.hasOwn(parameters.properties[name], 'nullable')) ||
      Object.values(parameters.properties).some(schema =>
        !onlyKeys(schema, ['type', 'enum', 'nullable', 'minimum', 'maximum', 'exclusiveMinimum',
          'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems',
          'description', 'title', 'default', 'examples']))) {
    throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'native reminder contains an unreviewed constraint');
  }
  const expected = { namespace: 'muse', function: 'submit_reminder_decision',
    required: ['advisory_text', 'confidence', 'decision', 'priority', 'reason', 'skill_id', 'visible_for_steps'],
    additionalProperties: false, properties: [
      { name: 'advisory_text', types: ['null', 'string'], nullable: true, bounds: {} },
      { name: 'confidence', types: ['null', 'string'], nullable: true, enum: ['low', 'medium', 'high'], bounds: {} },
      { name: 'decision', types: ['string'], nullable: false, enum: ['remind', 'none'], bounds: {} },
      { name: 'priority', types: ['null', 'string'], nullable: true, enum: ['low', 'normal', 'high'], bounds: {} },
      { name: 'reason', types: ['string'], nullable: false, bounds: {} },
      { name: 'skill_id', types: ['null', 'string'], nullable: true, bounds: {} },
      { name: 'visible_for_steps', types: ['null', 'integer'], nullable: true,
        bounds: { minimum: 1, maximum: 8 } },
    ] };
  if (!observed || JSON.stringify(observed) !== JSON.stringify(expected) ||
      body.tools[0].tools[0].strict !== true) {
    throw fault('NATIVE_REMINDER_SCHEMA_INVALID', 'native reminder differs from reviewed no-reminder contract');
  }
  return REMINDER_PAYLOAD;
}

export function reminderCallEvents(payload) {
  const args = JSON.stringify(payload);
  const item = status => ({ type: 'function_call', id: REMINDER_ITEM, call_id: REMINDER_CALL,
    namespace: 'muse', name: 'submit_reminder_decision', arguments: status === 'completed' ? args : '', status });
  const frame = (status, output) => ({ id: REMINDER_RESPONSE, object: 'response',
    model: SHELL_MODEL, status, output });
  return [
    { type: 'response.created', sequence_number: 1, response: frame('in_progress', []) },
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: item('in_progress') },
    { type: 'response.function_call_arguments.delta', sequence_number: 3, output_index: 0,
      item_id: REMINDER_ITEM, delta: args },
    { type: 'response.function_call_arguments.done', sequence_number: 4, output_index: 0,
      item_id: REMINDER_ITEM, name: 'submit_reminder_decision', arguments: args },
    { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: item('completed') },
    { type: 'response.completed', sequence_number: 6, response: {
      ...frame('completed', [item('completed')]), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

function selectedToolSchemaDiscovery(body, { name, index, digest, marker,
  functionCount = 25, countName = name === 'bash' ? 'bashCount' : 'readFileCount',
  allowPrevious = false, allowFunctionOutput = false }) {
  const namespace = body?.tools?.length === 1 ? body.tools[0] : null;
  const functions = namespace?.tools;
  const inputText = JSON.stringify(body?.input);
  if (body?.model !== SHELL_MODEL || namespace?.type !== 'namespace' || namespace.name !== 'muse' ||
      !Array.isArray(functions) || functions.length !== functionCount ||
      functions.some(tool => tool?.type !== 'function' || typeof tool.name !== 'string') ||
      !allowPrevious && body.previous_response_id != null ||
      marker && !inputText?.includes(marker) ||
      !allowFunctionOutput && Array.isArray(body.input) &&
        body.input.some(item => item?.type === 'function_call_output')) return null;
  const digestName = name => createHash('sha256').update(name).digest('hex');
  const entries = functions.map((tool, index) => ({ index, name: tool.name === name ? name : '[other]',
    nameLength: Buffer.byteLength(tool.name), nameSha256: digestName(tool.name),
    parameterKeys: tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters) ?
      Object.keys(tool.parameters).filter(key => ['type', 'properties', 'required', 'additionalProperties',
        'anyOf', 'oneOf', 'allOf'].includes(key)) : [] }));
  const matchingIndexes = functions.flatMap((tool, position) => tool.name === name ? [position] : []);
  const identityValid = matchingIndexes.length === 1 && matchingIndexes[0] === index &&
    digestName(functions[index].name) === digest;
  const selectedTool = identityValid ? functions[index] : null;
  const safeIdentifier = value => value === 'max_output_tokens' || typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value) &&
    !/(?:secret|token|password|credential|authorization|bearer|cookie|header|api_key|^sk_)/i.test(value);
  const safeLiteral = value => value === null || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ||
    typeof value === 'string' && /^[A-Za-z0-9_.-]{0,32}$/.test(value) &&
      !/(?:secret|token|password|credential|authorization|bearer|cookie|header|api_key|^sk_)/i.test(value);
  const identifier = value => safeIdentifier(value) ? value : {
    unsafe: true, length: typeof value === 'string' ? Buffer.byteLength(value) : null,
    sha256: typeof value === 'string' ? digestName(value) : null };
  const context = { nodes: 0, unsupported: 0, omitted: 0 };
  if (Object.keys(namespace).some(key => !['type', 'name', 'tools', 'description'].includes(key))) {
    context.unsupported++;
  }
  const project = (schema, depth = 0) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 6 ||
        ++context.nodes > 128) { context.unsupported++; return { incomplete: true }; }
    const result = {};
    for (const [key, value] of Object.entries(schema)) {
      if (['description', 'title', 'examples'].includes(key)) continue;
      if (key === 'default') { context.unsupported++; continue; }
      if (key === 'type') {
        const types = Array.isArray(value) ? value : [value];
        if (!types.length || types.some(type => !['object', 'array', 'string', 'integer',
          'number', 'boolean', 'null'].includes(type)) || new Set(types).size !== types.length) {
          context.unsupported++; result.type = '[unsupported]';
        } else result.type = value;
      } else if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        const fields = Object.entries(value);
        result.propertyCount = fields.length;
        result.properties = fields.slice(0, 32).map(([name, property]) => {
          if (!safeIdentifier(name)) context.unsupported++;
          return { name: identifier(name), schema: project(property, depth + 1) };
        });
        if (fields.length > 32) { context.omitted += fields.length - 32; result.omittedProperties = fields.length - 32; }
      } else if (key === 'required' && Array.isArray(value)) {
        result.requiredCount = value.length;
        result.required = value.slice(0, 32).map(name => {
          if (!safeIdentifier(name)) context.unsupported++;
          return identifier(name);
        });
        if (new Set(value).size !== value.length) context.unsupported++;
        if (value.length > 32) { context.omitted += value.length - 32; result.omittedRequired = value.length - 32; }
      } else if (key === 'enum' && Array.isArray(value)) {
        result.enumCount = value.length;
        result.enum = value.slice(0, 16).map(item => {
          if (safeLiteral(item)) return item;
          context.unsupported++;
          return { unsafe: true, type: item === null ? 'null' : typeof item };
        });
        if (!value.length || new Set(value.map(item => JSON.stringify(item))).size !== value.length) context.unsupported++;
        if (value.length > 16) { context.omitted += value.length - 16; result.omittedEnum = value.length - 16; }
      } else if (key === 'const') {
        if (safeLiteral(value)) result.const = value;
        else { context.unsupported++; result.const = { unsafe: true, type: value === null ? 'null' : typeof value }; }
      } else if (key === 'nullable' && typeof value === 'boolean') result.nullable = value;
      else if (key === 'additionalProperties' && typeof value === 'boolean') result.additionalProperties = value;
      else if (key === 'additionalProperties' && value && typeof value === 'object' && !Array.isArray(value)) {
        result.additionalProperties = project(value, depth + 1);
      } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
        result.items = project(value, depth + 1);
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
        result[key] = value.slice(0, 8).map(item => project(item, depth + 1));
        if (!value.length) context.unsupported++;
        if (value.length > 8) { context.omitted += value.length - 8; result[`omitted${key}`] = value.length - 8; }
      } else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
        'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) &&
        typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 &&
        (!['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) ||
          Number.isInteger(value) && value >= 0) && (key !== 'multipleOf' || value > 0)) {
        result[key] = value;
      } else {
        context.unsupported++;
      }
    }
    return result;
  };
  let selected = null;
  if (selectedTool) {
    const fields = Object.keys(selectedTool);
    if (fields.some(key => !['type', 'name', 'parameters', 'strict', 'description'].includes(key)) ||
        selectedTool.strict !== undefined && typeof selectedTool.strict !== 'boolean') context.unsupported++;
    selected = { index, name, type: 'function',
      strict: selectedTool.strict === true ? true : selectedTool.strict === false ? false :
        selectedTool.strict === undefined ? 'unspecified' : 'invalid',
      schema: project(selectedTool.parameters) };
  }
  const summary = { namespace: 'muse', functionCount: functions.length, omittedFunctions: 0,
    functions: entries, [countName]: matchingIndexes.length,
    identityValid, selected,
    unsupportedCount: context.unsupported, omittedConstraints: context.omitted,
    selectedComplete: identityValid && context.unsupported === 0 && context.omitted === 0 };
  if (Buffer.byteLength(JSON.stringify(summary)) > 16_384) {
    summary.selected = null;
    summary.selectedTruncated = true;
    summary.selectedComplete = false;
  }
  if (Buffer.byteLength(JSON.stringify(summary)) > 16_384) {
    summary.functions = entries.map(({ index, name, nameSha256 }) => ({ index, name, nameSha256 }));
  }
  return summary;
}

export function mainSchemaDiscovery(body) {
  return selectedToolSchemaDiscovery(body, { name: 'bash', index: 11,
    digest: '37d2b12d5d9abc2a364ef9448767ee03938e383c0284193477dc7618f4b7c6c2',
    marker: 'NATIVE_SHELL_PROBE' });
}

export function readFileSchemaDiscovery(body) {
  const summary = selectedToolSchemaDiscovery(body, { name: 'read_file', index: 1,
    digest: 'c9f8123bd2726fc2414267256101446c45647b4754b1bad58feaf205125b4c96',
    marker: 'NATIVE_READ_FILE_SCHEMA_PROBE' });
  if (summary?.identityValid) {
    const parameters = body.tools[0].tools[1].parameters;
    const names = parameters?.properties && typeof parameters.properties === 'object' &&
      !Array.isArray(parameters.properties) ? Object.keys(parameters.properties) : [];
    if (parameters?.type !== 'object' || names.length === 0 ||
        !Array.isArray(parameters.required) ||
        parameters.required.some(required => !names.includes(required)) ||
        !Object.hasOwn(parameters, 'additionalProperties')) summary.selectedComplete = false;
  }
  return summary;
}

export function verificationReminderSchemaDiscovery(body) {
  const tool = body?.tools?.[0]?.tools?.[0];
  if (tool?.name !== 'submit_reminder_decision' ||
      Object.keys(tool.parameters?.properties ?? {}).length === 7) return null;
  const summary = selectedToolSchemaDiscovery(body, { name: 'submit_reminder_decision', index: 0,
    digest: '4a3837b69a6fc85cd9a85f75160accf94f068c870f8ff8b6f44e60d138080f45',
    marker: null, functionCount: 1, countName: 'reminderCount',
    allowPrevious: true, allowFunctionOutput: true });
  if (summary) {
    const parameters = tool.parameters;
    const names = parameters?.properties && typeof parameters.properties === 'object' &&
      !Array.isArray(parameters.properties) ? Object.keys(parameters.properties) : [];
    if (parameters?.type !== 'object' || names.length !== 3 ||
        !Array.isArray(parameters.required) || parameters.required.length !== 3 ||
        parameters.required.some(required => !names.includes(required)) ||
        !Object.hasOwn(parameters, 'additionalProperties')) summary.selectedComplete = false;
  }
  return summary;
}

export function verificationReminderAssociation(body, state, requestIndex) {
  const issuedMain = state.main === 'schema-observed';
  const issuedReminder = state.reminder === 'none-issued';
  const previous = body?.previous_response_id == null ? 'absent' :
    body.previous_response_id === 'resp_native_read_file_schema_1' && issuedMain ? 'issued_main' :
      body.previous_response_id === REMINDER_RESPONSE && issuedReminder ? 'issued_reminder' : 'foreign';
  const input = body?.input;
  const items = Array.isArray(input) ? input : [];
  const itemFacts = items.slice(0, 16).map(item => ({
    type: ['message', 'function_call_output', 'function_call', 'reasoning'].includes(item?.type) ?
      item.type : '[other]',
    itemId: item?.id == null ? 'absent' :
      item.id === 'msg_native_read_file_schema_1' && issuedMain ? 'issued_main' :
        item.id === REMINDER_ITEM && issuedReminder ? 'issued_reminder' : 'foreign',
    callId: item?.call_id == null ? 'absent' :
      item.call_id === REMINDER_CALL && issuedReminder ? 'issued_reminder' : 'foreign',
  }));
  const foreign = previous === 'foreign' || itemFacts.some(item =>
    item.itemId === 'foreign' || item.callId === 'foreign');
  const mainReference = previous === 'issued_main' || itemFacts.some(item => item.itemId === 'issued_main');
  const reminderReference = previous === 'issued_reminder' || itemFacts.some(item =>
    item.itemId === 'issued_reminder' || item.callId === 'issued_reminder');
  return { requestIndex, previousResponse: previous,
    inputKind: Array.isArray(input) ? 'array' : typeof input === 'string' ? 'string' : '[other]',
    inputCount: Array.isArray(input) ? input.length : null, itemFacts,
    omittedItems: Math.max(0, items.length - 16),
    issuedAtRequest: { main: issuedMain, reminder: issuedReminder },
    httpRelation: foreign ? 'foreign' : mainReference && reminderReference ? 'ambiguous' :
      mainReference ? 'issued_main' : reminderReference ? 'issued_reminder' : 'unknown',
    nativeReminderChildRelation: 'unknown' };
}

const FIXED_BASH_SCHEMA = Object.freeze({ index: 11, name: 'bash', type: 'function', strict: false,
  schema: { additionalProperties: false, propertyCount: 10, properties: [
    { name: 'command', schema: { type: 'string' } },
    { name: 'description', schema: { type: 'string' } },
    { name: 'login', schema: { type: 'boolean' } },
    { name: 'max_output_tokens', schema: { minimum: 1, type: 'integer' } },
    { name: 'sandbox_permissions', schema: { enumCount: 2,
      enum: ['use_default', 'require_escalated'], type: 'string' } },
    { name: 'shell', schema: { type: 'string' } },
    { name: 'timeout_ms', schema: { minimum: 1, type: 'integer' } },
    { name: 'tty', schema: { type: 'boolean' } },
    { name: 'workdir', schema: { type: 'string' } },
    { name: 'yield_time_ms', schema: { minimum: 0, type: 'integer' } },
  ], requiredCount: 2, required: ['command', 'description'], type: 'object' } });

export function fixedBashCall(body, command) {
  const observed = mainSchemaDiscovery(body);
  if (!observed?.selectedComplete || !observed.identityValid ||
      JSON.stringify(observed.selected) !== JSON.stringify(FIXED_BASH_SCHEMA) ||
      typeof command !== 'string' || !command) {
    throw fault('NATIVE_BASH_SCHEMA_INVALID', 'advertised native bash schema differs from reviewed contract');
  }
  return { namespace: 'muse', name: 'bash', arguments: {
    command, description: 'Disposable native shell qualification' }, schema: observed };
}

export function bashCallEvents(args) {
  const serialized = JSON.stringify(args);
  const item = status => ({ type: 'function_call', id: SHELL_ITEM, call_id: SHELL_CALL,
    namespace: 'muse', name: 'bash', arguments: status === 'completed' ? serialized : '', status });
  const frame = (status, output) => ({ id: SHELL_RESPONSE, object: 'response',
    model: SHELL_MODEL, status, output });
  return [
    { type: 'response.created', sequence_number: 1, response: frame('in_progress', []) },
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: item('in_progress') },
    { type: 'response.function_call_arguments.delta', sequence_number: 3, output_index: 0,
      item_id: SHELL_ITEM, delta: serialized },
    { type: 'response.function_call_arguments.done', sequence_number: 4, output_index: 0,
      item_id: SHELL_ITEM, namespace: 'muse', name: 'bash', arguments: serialized },
    { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: item('completed') },
    { type: 'response.completed', sequence_number: 6, response: {
      ...frame('completed', [item('completed')]), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

export function shellOutputMarkers(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > LIMIT) return null;
  const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n');
  if (lines.length !== 5 || !/^workspace=(ok|failed)$/.test(lines[0]) ||
      lines[1] !== 'direct=denied' || lines[2] !== 'symlink=denied' ||
      lines[3] !== 'proc=denied' || !/^dummy-auth=(visible|absent)$/.test(lines[4])) return null;
  return { workspaceWritten: lines[0] === 'workspace=ok', dummyAuthVisible: lines[4] === 'dummy-auth=visible' };
}

export function matchingShellResult(body) {
  return body?.model === SHELL_MODEL && body.previous_response_id === SHELL_RESPONSE &&
    Array.isArray(body.input) && body.input.length === 1 &&
    body.input[0]?.type === 'function_call_output' && body.input[0].call_id === SHELL_CALL &&
    Object.keys(body.input[0]).sort().join(',') === 'call_id,output,type' &&
    shellOutputMarkers(body.input[0].output) !== null;
}

export function shellResultEnvelopeShape(body) {
  const input = body?.input;
  const items = Array.isArray(input) ? input.slice(0, 4).map(item => ({
    type: item?.type === 'function_call_output' ? 'function_call_output' : 'other',
    fieldCount: item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item).length : null,
    unknownFieldCount: item && typeof item === 'object' && !Array.isArray(item) ?
      Object.keys(item).filter(key => !['type', 'call_id', 'output'].includes(key)).length : null,
    callId: item?.call_id === SHELL_CALL ? 'issued_shell' :
      item?.call_id === REMINDER_CALL ? 'reminder' : 'other',
    outputType: typeof item?.output,
    outputBytes: typeof item?.output === 'string' ? Buffer.byteLength(item.output) : null,
    bareMarkers: shellOutputMarkers(item?.output) !== null,
  })) : [];
  return { model: summarizedShellModel(body?.model),
    previousResponse: body?.previous_response_id === SHELL_RESPONSE ? 'issued_shell' :
      body?.previous_response_id === REMINDER_RESPONSE ? 'reminder' : 'other',
    inputType: Array.isArray(input) ? 'array' : typeof input,
    inputCount: Array.isArray(input) ? input.length : null,
    omittedItems: Array.isArray(input) ? Math.max(0, input.length - 4) : 0, items };
}

export function shellTextEvents(text = 'Fixture shell result observed.',
  responseId = SHELL_TEXT_RESPONSE, messageId = 'msg_native_shell_2') {
  const part = value => ({ type: 'output_text', text: value, annotations: [] });
  const textItem = status => ({ type: 'message', id: messageId, role: 'assistant',
    status, content: status === 'completed' ?
      [part(text)] : [] });
  const frame = (status, output) => ({ id: responseId, object: 'response',
    model: SHELL_MODEL, status, output });
  return [
    { type: 'response.created', sequence_number: 1, response: frame('in_progress', []) },
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: textItem('in_progress') },
    { type: 'response.content_part.added', sequence_number: 3, output_index: 0,
      item_id: messageId, content_index: 0, part: part('') },
    { type: 'response.output_text.delta', sequence_number: 4, output_index: 0,
      item_id: messageId, content_index: 0, delta: text },
    { type: 'response.output_text.done', sequence_number: 5, output_index: 0,
      item_id: messageId, content_index: 0, text },
    { type: 'response.content_part.done', sequence_number: 6, output_index: 0,
      item_id: messageId, content_index: 0, part: part(text) },
    { type: 'response.output_item.done', sequence_number: 7, output_index: 0, item: textItem('completed') },
    { type: 'response.completed', sequence_number: 8, response: {
      ...frame('completed', [textItem('completed')]),
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

export async function startShellProvider(forbiddenPort, command, {
  makeServer = createServer, waitListen = listen, shut = close, readFileSchemaOnly = false,
} = {}) {
  const requests = [];
  const state = { main: 'unseen', reminder: 'unseen', failed: false, admissionClosed: false,
    active: 0, attempts: 0, catalogAttempts: 0, inputBytes: 0, outputBytes: 0,
    omittedRequests: 0 };
  const record = summary => {
    if (requests.length < 7) requests.push(summary);
    else {
      state.omittedRequests++;
      if (requests.length === 7) requests.push({ kind: 'omitted_requests', count: 1 });
      else requests[7].count = state.omittedRequests;
    }
  };
  let reportRejection;
  let rejectionReported = false;
  const rejection = new Promise(resolve => { reportRejection = resolve; });
  const reject = (code, summary, response, status = 422) => {
    state.failed = true;
    state.primaryCode ??= code;
    if (summary) summary.rejection = code;
    if (!rejectionReported) {
      rejectionReported = true;
      reportRejection({ kind: 'provider_rejected', code });
    }
    response.writeHead(status).end();
  };
  const server = makeServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/muse-code/models' && !state.admissionClosed) {
      const summary = { method: 'GET', path: '/muse-code/models', bytes: 0, model: 'invalid' };
      state.catalogAttempts++;
      record(summary);
      if (state.failed || state.catalogAttempts > 4) {
        reject('NATIVE_CATALOG_BUDGET_EXCEEDED', summary, response, 429); return;
      }
      const catalog = JSON.stringify({ object: 'list', data: [{ id: SHELL_MODEL, object: 'model', metadata: {
        'muse-code': { release_date: '2026-01-01', is_hidden: false,
          limit: { context: 1_000_000, output: 1024 } },
      } }] });
      if (state.outputBytes + Buffer.byteLength(catalog) > LIMIT) {
        reject('NATIVE_OUTPUT_BUDGET_EXCEEDED', summary, response, 429); return;
      }
      state.outputBytes += Buffer.byteLength(catalog);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(catalog);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(501).end(); return;
    }
    const summary = { method: 'POST', path: '/responses', bytes: 0, model: 'invalid',
      responseIndex: state.attempts + 1 };
    record(summary);
    // Admission and aggregate budgets are reserved before reading an untrusted body.
    state.attempts++;
    if (request.url !== '/responses') {
      summary.path = 'invalid';
      reject('NATIVE_REQUEST_PATH_INVALID', summary, response, 404); return;
    }
    if (state.failed || state.admissionClosed || state.attempts > 3 || state.active >= 2) {
      reject('NATIVE_REQUEST_BUDGET_EXCEEDED', summary, response, 429); return;
    }
    // Body completion can reorder concurrent requests. Attribution uses the state at admission.
    const issuanceAtAdmission = { main: state.main, reminder: state.reminder };
    state.active++;
    try {
      let body = '';
      try {
        for await (const chunk of request) {
          const size = Buffer.byteLength(chunk);
          summary.bytes += size;
          state.inputBytes += size;
          if (summary.bytes > PROVIDER_INPUT_LIMIT || state.inputBytes > PROVIDER_INPUT_LIMIT * 3) {
            throw fault('REQUEST_TOO_LARGE', 'native provider request exceeds bounded input budget');
          }
          body += chunk;
        }
      } catch (error) {
        reject(error.code === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' :
          'REQUEST_READ_FAILED', summary, response, 413); return;
      }
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { reject('REQUEST_JSON_INVALID', summary, response, 400); return; }
      summary.model = summarizedShellModel(parsed?.model);
      // Admission was reserved before the body arrived. Freeze bars new requests but lets
      // this already-admitted stream finish under its original permission.
      if (state.failed) { reject('NATIVE_REQUEST_REJECTED', summary, response); return; }
      try {
        if (readFileSchemaOnly) {
          const verification = verificationReminderSchemaDiscovery(parsed);
          if (verification) {
            const association = verificationReminderAssociation(parsed, issuanceAtAdmission,
              summary.responseIndex);
            const evidenceBytes = Buffer.byteLength(JSON.stringify({ verification, association }));
            if (state.outputBytes + evidenceBytes > LIMIT) {
              throw fault('NATIVE_OUTPUT_BUDGET_EXCEEDED', 'verification reminder evidence exceeds bound');
            }
            state.outputBytes += evidenceBytes;
            summary.kind = 'native_verification_reminder_schema';
            summary.selectedNameSha256 =
              '4a3837b69a6fc85cd9a85f75160accf94f068c870f8ff8b6f44e60d138080f45';
            summary.verificationSchema = verification;
            summary.association = association;
            throw fault(association.omittedItems ? 'NATIVE_VERIFY_REMINDER_ASSOCIATION_INCOMPLETE' :
              association.httpRelation === 'foreign' ? 'NATIVE_VERIFY_REMINDER_ASSOCIATION_FOREIGN' :
                verification.selectedComplete ? 'NATIVE_VERIFY_REMINDER_SCHEMA_ONLY' :
                  'NATIVE_VERIFY_REMINDER_SCHEMA_INCOMPLETE',
            'unreviewed verification reminder observed without a function response');
          }
        }
        const reminder = recognizedReminderSchema(parsed);
        if (reminder) {
          if (state.reminder !== 'unseen' || parsed.previous_response_id != null ||
              !JSON.stringify(parsed.input)?.includes(readFileSchemaOnly ?
                'NATIVE_READ_FILE_SCHEMA_PROBE' : 'NATIVE_SHELL_PROBE') ||
              (Array.isArray(parsed.input) && parsed.input.some(item => item?.type === 'function_call_output'))) {
            throw fault('NATIVE_REMINDER_SEQUENCE_INVALID', 'duplicate or correlated reminder request');
          }
          const payload = fixedNoReminderPayload(parsed);
          const events = reminderCallEvents(payload);
          const output = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
          const outputBytes = Buffer.byteLength(output);
          if (state.outputBytes + outputBytes > LIMIT) {
            throw fault('NATIVE_OUTPUT_BUDGET_EXCEEDED', 'native fixture output exceeds budget');
          }
          state.reminder = 'none-issued';
          state.outputBytes += outputBytes;
          summary.kind = 'native_reminder_call';
          summary.responseId = REMINDER_RESPONSE;
          summary.itemId = REMINDER_ITEM;
          summary.callId = REMINDER_CALL;
          summary.payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(output);
          return;
        }
        const main = readFileSchemaOnly ? readFileSchemaDiscovery(parsed) : mainSchemaDiscovery(parsed);
        if (main) {
          if (state.main !== 'unseen') throw fault('NATIVE_MAIN_REPLAY', 'duplicate main request');
          summary.mainSchema = main;
          if (readFileSchemaOnly) {
            const events = shellTextEvents('Schema observed; no file tool was called.',
              'resp_native_read_file_schema_1', 'msg_native_read_file_schema_1');
            const output = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
            const outputBytes = Buffer.byteLength(output) + Buffer.byteLength(JSON.stringify(main));
            if (state.outputBytes + outputBytes > LIMIT) {
              throw fault('NATIVE_OUTPUT_BUDGET_EXCEEDED', 'read_file schema evidence exceeds output budget');
            }
            state.main = 'schema-observed';
            state.outputBytes += outputBytes;
            summary.kind = 'native_read_file_schema';
            summary.responseId = 'resp_native_read_file_schema_1';
            summary.schemaSha256 = main.selected &&
              createHash('sha256').update(JSON.stringify(main.selected)).digest('hex');
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(output);
            return;
          }
          const selected = fixedBashCall(parsed, command);
          const events = bashCallEvents(selected.arguments);
          const output = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
          const outputBytes = Buffer.byteLength(output) + Buffer.byteLength(JSON.stringify(main));
          if (state.outputBytes + outputBytes > LIMIT) {
            throw fault('NATIVE_OUTPUT_BUDGET_EXCEEDED', 'native shell response exceeds budget');
          }
          state.main = 'call-issued';
          state.outputBytes += outputBytes;
          summary.kind = 'native_tool_call';
          summary.namespace = 'muse';
          summary.responseId = SHELL_RESPONSE;
          summary.itemId = SHELL_ITEM;
          summary.callId = SHELL_CALL;
          summary.argumentKeys = Object.keys(selected.arguments);
          summary.commandSha256 = createHash('sha256').update(command).digest('hex');
          summary.schemaSha256 = createHash('sha256').update(JSON.stringify(main.selected)).digest('hex');
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(output);
          return;
        }
        if (state.main === 'call-issued') {
          if (!matchingShellResult(parsed)) {
            summary.resultEnvelope = shellResultEnvelopeShape(parsed);
            throw fault('NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN', 'native result envelope differs from reviewed call identity');
          }
          const events = shellTextEvents();
          const output = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
          const outputBytes = Buffer.byteLength(output);
          if (state.outputBytes + outputBytes > LIMIT) {
            throw fault('NATIVE_OUTPUT_BUDGET_EXCEEDED', 'native result response exceeds budget');
          }
          state.main = 'result-accepted';
          state.outputBytes += outputBytes;
          summary.kind = 'matching_tool_result';
          summary.responseId = SHELL_TEXT_RESPONSE;
          summary.forCallId = SHELL_CALL;
          summary.outputMarkers = shellOutputMarkers(parsed.input[0].output);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(output);
          return;
        }
        throw fault('NATIVE_REQUEST_UNCLASSIFIED', 'native request is neither reviewed stream');
      } catch (error) {
        if (!summary.verificationSchema) summary.schemaShape = rejectedToolSchemaShape(parsed);
        reject(error.code ?? 'NATIVE_REQUEST_UNCLASSIFIED', summary, response);
      }
    } finally { state.active--; }
  });
  const port = await waitListen(server);
  try { assertPortSeparation(forbiddenPort, port); }
  catch (error) { await shut(server); throw error; }
  let closing;
  const freeze = () => {
    if (!closing) {
      state.admissionClosed = true;
      closing = (async () => {
        await shut(server);
        for (let attempt = 0; state.active > 0 && attempt < 100; attempt++) await pause(10);
        if (state.active !== 0) {
          throw fault('NATIVE_PROVIDER_DRAIN_UNCONFIRMED', 'provider still has an admitted request after close');
        }
      })();
    }
    return closing;
  };
  return { port, requests, rejection, state,
    freeze, close: freeze };
}

export async function tcpProbe(address, port, ms = 700) {
  return new Promise(resolveResult => {
    const socket = connect({ host: address, port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolveResult(value); };
    socket.once('connect', () => finish({ kind: 'connected' }));
    socket.once('error', error => finish({ kind: 'error', code: error.code ?? 'UNKNOWN' }));
    socket.setTimeout(ms, () => finish({ kind: 'timeout' }));
  });
}

export function classifyNoRoute(probe) {
  return probe.kind === 'error' && ['ENETUNREACH', 'EHOSTUNREACH'].includes(probe.code);
}

export function loopbackReady(result) {
  if (result?.status !== 0 || typeof result.stdout !== 'string') return false;
  const line = result.stdout.trim();
  return /^\d+: lo: <[^>]*\bLOOPBACK\b[^>]*\bUP\b[^>]*>/.test(line) ||
    /^\d+: lo: <[^>]*\bUP\b[^>]*\bLOOPBACK\b[^>]*>/.test(line);
}

export function assertNoTurn(commands, requests) {
  const allowed = commands[0] === 'session/resume' ? ['session/resume', 'session/read'] : ['session/start', 'session/read'];
  if (commands.length !== 2 || commands.some((value, index) => value !== allowed[index]) ||
      requests.some(({ method, path }) => method === 'POST' && path === '/responses')) {
    throw fault('UNEXPECTED_TURN', 'native command or provider request exceeded idle metadata allowlist');
  }
}

export function validateIdleRead(started, read, workspace, home) {
  const id = started?.session?.sessionId;
  const session = read?.session;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      started.session.workspaceRoot !== workspace || session?.sessionId !== id ||
      session?.workspaceRoot !== workspace || session?.activeTurnId !== null || session?.turnCount !== 0 ||
      session?.status !== 'idle' || !Array.isArray(read.pendingRequests) || read.pendingRequests.length !== 0 ||
      read.history?.mode !== 'none' || read.history?.noneReason !== 'excluded' ||
      read.history?.items !== null || read.history?.snapshot !== null ||
      typeof read.viewCursor !== 'string' || typeof session?.path !== 'string' ||
      !session.path.startsWith(`${home}/`)) {
    throw fault('INVALID_SESSION_READ', 'session/read did not return matching idle durable metadata');
  }
  return { sessionId: id, workspaceRoot: workspace, status: session.status,
    durableLogPath: session.path, turnCount: session.turnCount, activeTurnId: session.activeTurnId,
    pendingCount: read.pendingRequests.length, history: read.history.mode, viewCursor: read.viewCursor };
}

function procIdentity(stat) {
  const pid = Number(/^([1-9]\d*) \(/.exec(stat)?.[1]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  const start = fields[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group) ||
      !Number.isSafeInteger(session) || !/^\d+$/.test(start ?? '')) {
    throw fault('NATIVE_IDENTITY_UNVERIFIED', 'native PID marker or live process stat was invalid');
  }
  return { pid, group, session, start, state: fields[0] };
}

export async function verifiedNativeNamespace(home, native, guestNamespace, {
  read = readFile, link = readlink, canonicalize = realpath,
} = {}) {
  const marker = procIdentity(await read(join(home, 'native.stat'), 'utf8'));
  const live = procIdentity(await read(`/proc/${marker.pid}/stat`, 'utf8'));
  const markerNamespace = (await read(join(home, 'native.netns'), 'utf8')).trim();
  const currentNamespace = await link(`/proc/${marker.pid}/ns/net`);
  const executable = await link(`/proc/${marker.pid}/exe`);
  if (marker.pid !== live.pid || marker.start !== live.start ||
      live.state === 'Z' || live.state === 'X' || live.group !== live.pid || live.session !== live.pid ||
      marker.group !== marker.pid || marker.session !== marker.pid ||
      markerNamespace !== guestNamespace || currentNamespace !== guestNamespace ||
      executable !== await canonicalize(native)) {
    throw fault('NATIVE_IDENTITY_UNVERIFIED', 'native birth, process group, executable or namespace changed after wrapper exec');
  }
  return { pid: live.pid, start: live.start, group: live.group, session: live.session,
    namespace: currentNamespace, executable };
}

async function prepareSessions(home) {
  const made = [];
  let path = home;
  for (const part of ['.local', 'share', 'muse', 'sessions']) {
    path = join(path, part);
    await mkdir(path, { mode: 0o700 });
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o7777) !== 0o700) {
      throw fault('SESSION_DIRECTORY_INVALID', 'guest session directory owner/mode mismatch');
    }
    made.push(relative(home, path));
  }
  if ((await readdir(path)).length !== 0) throw fault('SESSION_DIRECTORY_INVALID', 'sessions directory is not empty');
  return made;
}

async function pathAbsent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return true; throw error; }
}

export async function canaryChecks(protectedRoot, workspace, token) {
  const direct = join(protectedRoot, token);
  const linked = join(workspace, 'protected-link');
  const proc = `/proc/1/root${direct}`;
  return { directAbsent: await pathAbsent(direct), symlinkAbsent: await pathAbsent(join(linked, token)),
    procAbsent: await pathAbsent(proc) };
}

export async function guestRun(config) {
  const { spawnMspConnection } = await import(pathToFileURL(`${GUEST_RUNTIME}/sdk/dist/src/index.js`).href);
  const env = guestEnvironment();
  const workspace = config.workspace;
  const hostPort = config.hostPort;
  const native = `${GUEST_RUNTIME}/muse-bin-${VERSION}`;
  const namespace = await readlink('/proc/self/ns/net');
  const loopback = spawnSync('/usr/sbin/ip', ['-o', 'link', 'show', 'lo'], { encoding: 'utf8', timeout: 2_000 });
  if (!loopbackReady(loopback)) throw fault('GUEST_LOOPBACK_UNAVAILABLE', 'guest loopback was not observed UP');
  const provider = await startGuestProvider(hostPort);
  let host;
  const commands = [];
  let stage = 'network';
  try {
    const sentinel = await tcpProbe('127.0.0.1', hostPort);
    const external = await tcpProbe('203.0.113.1', 443);
    if (sentinel.kind === 'connected' || !classifyNoRoute(external)) {
      throw fault('NETWORK_BOUNDARY_UNVERIFIED', 'guest loopback or numeric no-route condition was not established');
    }
    stage = 'canaries';
    const canaries = await canaryChecks(config.protectedRoot, workspace, config.canaryToken);
    if (Object.values(canaries).some(value => value !== true)) throw fault('PROTECTED_CANARY_VISIBLE', 'protected canary visible inside guest');
    stage = 'sessions';
    const sessionDirectories = config.phase === 'resume' ? [] : await prepareSessions(GUEST_HOME);
    const settings = join(GUEST_HOME, '.config', 'muse');
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'settings.json'), `${JSON.stringify({ schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${provider.port}`, auth: 'bearer' } })}\n`, { mode: 0o600 });
    await writeFile(join(settings, 'auth.json'), `${JSON.stringify({ schema_version: 1,
      providers: { meta: { api_key: 'passeur-disposable-dummy-key' } } })}\n`, { mode: 0o600 });
    stage = 'host_initialize';
    host = spawnMspConnection({ command: `${GUEST_RUNTIME}/native-host-wrapper`, args: ['serve'], cwd: workspace, env,
      shutdownTimeoutMs: 2_000, onStderr: () => undefined });
    const initialized = await timeout('initialize', host.initialize({ clientInfo: {
      name: 'passeur_guest_transport_probe', version: '0.1.0',
    } }));
    const nativeIdentity = await verifiedNativeNamespace(GUEST_HOME, native, namespace);
    const nativeNamespace = nativeIdentity.namespace;
    stage = config.phase === 'resume' ? 'session_resume' : 'session_start';
    commands.push(config.phase === 'resume' ? 'session/resume' : 'session/start');
    const started = config.phase === 'resume'
      ? await timeout('session/resume', initialized.connection.command('session/resume',
        { sessionId: config.sessionId, excludeItems: true }, { maxAttempts: 1 }))
      : await timeout('session/start', initialized.connection.command('session/start',
        { workspaceRoot: workspace }, { maxAttempts: 1 }));
    const resumeMetadata = config.phase === 'resume'
      ? validateIdleRead(started, started, workspace, GUEST_HOME) : null;
    if (resumeMetadata && (resumeMetadata.sessionId !== config.sessionId ||
        resumeMetadata.durableLogPath !== config.logPath)) {
      throw fault('RESUME_IDENTITY_INVALID', 'resume envelope differs from original durable session');
    }
    stage = 'session_read';
    commands.push('session/read');
    const read = await timeout('session/read', initialized.connection.command('session/read',
      { sessionId: started?.session?.sessionId, excludeItems: true }, { maxAttempts: 1 }));
    const metadata = validateIdleRead(started, read, workspace, GUEST_HOME);
    const log = await realpath(metadata.durableLogPath);
    if (!log.startsWith(`${await realpath(GUEST_HOME)}/`) || !(await lstat(log)).isFile()) {
      throw fault('INVALID_SESSION_READ', 'durable log path escaped private guest HOME');
    }
    if (config.phase === 'resume') {
      if (metadata.sessionId !== config.sessionId || metadata.durableLogPath !== config.logPath) {
        throw fault('RESUME_IDENTITY_INVALID', 'resumed session or durable log differs from first host');
      }
      assertNoTurn(commands, provider.requests);
    } else assertNoTurn(commands, provider.requests);
    if (!provider.requests.some(request => request.method === 'GET' && request.path === '/muse-code/models')) {
      throw fault('NATIVE_CATALOG_MISSING', 'native host did not request guest catalog');
    }
    if (config.phase === 'resume') {
      const result = { kind: 'guest_resume_observed', stage, guestNamespace: namespace, nativeNamespace,
        nativeIdentity, hostPort, guestPort: provider.port, sentinel, external, canaries,
        sessionDirectories, metadata, resumeMetadata, nativeCatalogGet: true,
        commands, providerRequests: provider.requests };
      process.stdout.write(`${JSON.stringify({ kind: 'guest_ready', result })}\n`);
      if (await timeout('host release', config.release()) !== 'release') {
        throw fault('HOST_RELEASE_INVALID', 'resume host release was not authorized');
      }
      return result;
    }
    stage = 'direct_responses';
    const direct = await timeout('direct /responses', fetch(`http://127.0.0.1:${provider.port}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: 'transport only', tools: [] }),
    }));
    const directBody = await direct.json();
    if (direct.status !== 200 || directBody.id !== 'resp_transport' ||
        directBody.output?.[0]?.content?.[0]?.text !== 'Fixture transport only.') {
      throw fault('DIRECT_RESPONSE_INVALID', 'direct guest response fixture returned unexpected text response');
    }
    const responseRequests = provider.requests.filter(request => request.path === '/responses');
    if (responseRequests.length !== 1 || responseRequests[0].method !== 'POST' ||
        responseRequests[0].directMarker !== true) {
      throw fault('DIRECT_RESPONSE_ATTRIBUTION_INVALID', 'provider Responses request did not match the one direct client call');
    }
    const result = { kind: 'guest_transport_observed', stage, guestNamespace: namespace, nativeNamespace,
      nativeIdentity,
      hostPort, guestPort: provider.port, sentinel, external, canaries, sessionDirectories,
      metadata, nativeCatalogGet: true, directResponses: { attribution: 'direct_guest_client_text_only', status: direct.status },
      nativeTurnSubmitted: false, commands, providerRequests: provider.requests };
    if (config.phase === 'first') {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_ready', result })}\n`);
      if (await timeout('host release', config.release()) !== 'release') {
        throw fault('HOST_RELEASE_INVALID', 'first host release was not authorized');
      }
    }
    return result;
  } catch (error) {
    return { kind: 'guest_transport_error', stage, code: error.code ?? error.name,
      message: String(error.message).slice(0, 500), guestNamespace: namespace,
      hostPort, guestPort: provider.port, commands, providerRequests: provider.requests };
  } finally {
    try { if (host) await timeout('host close', host.close(), 5_000); } catch { /* stop remains unverified */ }
    try { await provider.close(); } catch { /* host retains fixture */ }
  }
}

export function approvalSummary(value, command) {
  if (typeof value?.approvalId !== 'string' || typeof value?.sessionId !== 'string' ||
      typeof value?.turnId !== 'string' || typeof value?.toolCallId !== 'string' ||
      value.toolName !== 'bash' || !Array.isArray(value.availableChoices) ||
      value.availableChoices.length < 1 || value.availableChoices.length > 16 ||
      value.availableChoices.some(choice => !choice || ['choiceId', 'decision', 'scope', 'label']
        .some(key => typeof choice[key] !== 'string' || !choice[key] || choice[key].length > 200)) ||
      new Set(value.availableChoices.map(choice => choice?.choiceId)).size !== value.availableChoices.length ||
      value.currentRequirementId?.approvalId !== value.approvalId ||
      !Number.isSafeInteger(value.currentRequirementId?.sourceIndex)) {
    throw fault('NATIVE_APPROVAL_INVALID', 'native approval identity or choices invalid');
  }
  let commandMatch = false;
  try {
    if (typeof value.rawArgs === 'string' && Buffer.byteLength(value.rawArgs) <= LIMIT) {
      const args = JSON.parse(value.rawArgs);
      commandMatch = args && typeof args === 'object' && !Array.isArray(args) &&
        Object.keys(args).sort().join(',') === 'command,description' &&
        args.command === command && args.description === 'Disposable native shell qualification';
    }
  } catch { /* rejected below */ }
  if (!commandMatch) throw fault('NATIVE_APPROVAL_INVALID', 'approval command differs from reviewed shell call');
  return { approvalId: value.approvalId, sessionId: value.sessionId, turnId: value.turnId,
    toolCallId: value.toolCallId, toolName: value.toolName, commandMatch,
    requirementId: { approvalId: value.currentRequirementId.approvalId,
      sourceIndex: value.currentRequirementId.sourceIndex },
    choices: value.availableChoices.map(choice => ({ choiceId: choice.choiceId,
      decision: choice.decision, scope: choice.scope, label: choice.label })) };
}

export function heldApprovalPresentation(approval, command, workspace, protectedRoot, token) {
  const summary = approvalSummary(approval, command);
  return { kind: 'native_shell_live_approval', handoffId: randomBytes(16).toString('hex'),
    approval: summary, command, waitBudgetMs: HELD_INPUT_MS,
    expiresAt: new Date(Date.now() + HELD_INPUT_MS).toISOString(),
    effects: { workspaceWrite: join(workspace, 'shell-canary'),
      protectedDirect: join(protectedRoot, token),
      protectedSymlink: join(workspace, 'protected-link', token),
      protectedProc: `/proc/1/root${join(protectedRoot, token)}`,
      dummyAuth: `${GUEST_HOME}/.config/muse/auth.json`,
      purpose: 'Disposable shell and protected-path probe; approval permits exactly the displayed command.' } };
}

export function validateHeldInitialApproval(metadata, ack, event, pending, command) {
  const approval = event?.approval;
  if (event?.kind !== 'approval' || approval?.sessionId !== metadata.sessionId ||
      approval.turnId !== ack.turnId || approval.toolCallId !== SHELL_CALL ||
      approval.toolName !== 'bash' || pending?.approvals?.length !== 1 ||
      pending.userInputs?.length !== 0 ||
      JSON.stringify(approvalSummary(pending.approvals[0], command)) !== JSON.stringify(approval)) {
    throw fault('NATIVE_HELD_APPROVAL_STALE', 'held approval is not the accepted fresh turn and call');
  }
  return approval;
}

export function validateHeldDecision(presentation, input, checkExpiry = true) {
  const approval = presentation?.approval;
  if (input?.kind !== 'choice' || Object.keys(input).sort().join(',') !==
      'approvalId,callId,choiceId,handoffId,kind,requirementId,sessionId,turnId' ||
      !Number.isFinite(Date.parse(presentation?.expiresAt)) ||
      checkExpiry && Date.now() >= Date.parse(presentation.expiresAt) ||
      input.handoffId !== presentation.handoffId || input.sessionId !== approval?.sessionId ||
      input.turnId !== approval?.turnId || input.callId !== approval?.toolCallId ||
      input.approvalId !== approval?.approvalId ||
      Object.keys(input.requirementId ?? {}).sort().join(',') !== 'approvalId,sourceIndex' ||
      input.requirementId.approvalId !== approval.requirementId.approvalId ||
      input.requirementId.sourceIndex !== approval.requirementId.sourceIndex ||
      !approval.choices.some(choice => choice.choiceId === input.choiceId)) {
    throw fault('NATIVE_HELD_DECISION_INVALID', 'human choice did not match the live approval and requirement');
  }
  return approval.choices.find(choice => choice.choiceId === input.choiceId);
}

export async function submitHeldDecision(connection, presentation, input, command, decisionState) {
  if (decisionState.submitted) throw fault('NATIVE_HELD_DUPLICATE_DECISION', 'approval decision already submitted');
  const choice = validateHeldDecision(presentation, input);
  const pending = await timeout('current approval/listPending', connection.request('approval/listPending',
    { sessionId: presentation.approval.sessionId }), 5_000);
  if (pending?.approvals?.length !== 1 || pending.userInputs?.length !== 0 ||
      JSON.stringify(approvalSummary(pending.approvals[0], command)) !== JSON.stringify(presentation.approval)) {
    throw fault('NATIVE_HELD_APPROVAL_STALE', 'current loaded approval differs from presented requirement');
  }
  const current = await timeout('current session/read', connection.command('session/read',
    { sessionId: presentation.approval.sessionId, excludeItems: true }, { maxAttempts: 1 }), 5_000);
  if (current?.session?.sessionId !== presentation.approval.sessionId ||
      current.session.activeTurnId !== presentation.approval.turnId) {
    throw fault('NATIVE_HELD_APPROVAL_STALE', 'loaded session no longer holds the presented turn');
  }
  const commandId = connection.mintCommandId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId)) {
    throw fault('NATIVE_HELD_COMMAND_ID_INVALID', 'SDK did not mint a UUIDv7 command ID');
  }
  decisionState.submitted = true;
  const ack = await timeout('approval/decide', connection.command('approval/decide', {
    approvalId: presentation.approval.approvalId, choiceId: choice.choiceId,
    requirementId: presentation.approval.requirementId, sessionId: presentation.approval.sessionId,
  }, { commandId, maxAttempts: 1 }), 10_000);
  if (ack?.status !== 'accepted' || ack.commandId !== commandId ||
      ack.approvalId !== presentation.approval.approvalId || typeof ack.terminal !== 'boolean') {
    throw fault('NATIVE_HELD_ACK_INVALID', 'approval decision admission acknowledgement differed');
  }
  return { commandId, choice, ack: { status: ack.status, terminal: ack.terminal,
    approvalId: ack.approvalId, commandId: ack.commandId } };
}

export async function guestShellRun(config) {
  const { spawnMspConnection } = await import(pathToFileURL(`${GUEST_RUNTIME}/sdk/dist/src/index.js`).href);
  const workspace = config.workspace;
  const native = `${GUEST_RUNTIME}/muse-bin-${VERSION}`;
  const namespace = await readlink('/proc/self/ns/net');
  const held = config.phase === 'held-shell';
  const readFileSchemaOnly = config.phase === 'read-file-schema';
  let provider;
  let host;
  let stage = 'network';
  const commands = [];
  const observations = { approvals: [], items: [], reminders: [], protocolErrors: [],
    omitted: { approvals: 0, items: 0, reminders: 0, protocolErrors: 0 } };
  const observe = (kind, value) => {
    if (observations[kind].length < 8) observations[kind].push(value);
    else observations.omitted[kind]++;
  };
  try {
    const loopback = spawnSync('/usr/sbin/ip', ['-o', 'link', 'show', 'lo'], { encoding: 'utf8', timeout: 2_000 });
    if (!loopbackReady(loopback)) throw fault('GUEST_LOOPBACK_UNAVAILABLE', 'guest loopback unavailable');
    const command = shellProbeCommand(workspace, config.protectedRoot, config.canaryToken);
    provider = await startShellProvider(config.hostPort, command, { readFileSchemaOnly });
    const sentinel = await tcpProbe('127.0.0.1', config.hostPort);
    const external = await tcpProbe('203.0.113.1', 443);
    if (sentinel.kind === 'connected' || !classifyNoRoute(external)) {
      throw fault('NETWORK_BOUNDARY_UNVERIFIED', 'guest network separation unavailable');
    }
    const canaries = await canaryChecks(config.protectedRoot, workspace, config.canaryToken);
    if (Object.values(canaries).some(value => value !== true)) throw fault('PROTECTED_CANARY_VISIBLE', 'protected canary visible');
    stage = 'sessions';
    const sessionDirectories = await prepareSessions(GUEST_HOME);
    const settings = join(GUEST_HOME, '.config', 'muse');
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'settings.json'), `${JSON.stringify({ schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${provider.port}`, auth: 'bearer' } })}\n`, { mode: 0o600 });
    await writeFile(join(settings, 'auth.json'), `${JSON.stringify({ schema_version: 1,
      providers: { meta: { api_key: 'passeur-disposable-dummy-key' } } })}\n`, { mode: 0o600 });
    stage = 'host_initialize';
    host = spawnMspConnection({ command: `${GUEST_RUNTIME}/native-host-wrapper`, args: ['serve'],
      cwd: workspace, env: guestEnvironment(), shutdownTimeoutMs: 2_000, onStderr: () => undefined });
    let resolveObserved;
    const observed = new Promise(resolve => { resolveObserved = resolve; });
    const heldEvents = [];
    let heldEventOverflow = false;
    const holdEvent = value => {
      if (held && heldEvents.length < 24) heldEvents.push(value);
      else if (held) heldEventOverflow = true;
    };
    host.onServerRequest(async request => {
      if (request.method !== 'approval/request') throw fault('NATIVE_REQUEST_UNEXPECTED', 'unexpected native request');
      if (held && observations.approvals.length > 0) {
        observe('approvals', { approvalId: request.params?.approvalId,
          sessionId: request.params?.sessionId, turnId: request.params?.turnId,
          toolCallId: request.params?.toolCallId, kind: 'additional_stage' });
        holdEvent({ kind: 'additional_approval_request' });
        return {};
      }
      const approval = approvalSummary(request.params, command);
      observe('approvals', approval);
      holdEvent({ kind: 'approval_request', approval });
      resolveObserved({ kind: 'approval', approval });
      return {}; // Presentation receipt only. No approval/decide is sent.
    });
    host.onNotification(notification => {
      const params = notification.params;
      if (notification.method === 'item/completed' && params?.item?.kind === 'toolCall') {
        const item = params.item;
        const outputShape = { type: item.visibleOutput === null ? 'null' : typeof item.visibleOutput,
          bytes: typeof item.visibleOutput === 'string' ? Buffer.byteLength(item.visibleOutput) : null,
          lines: typeof item.visibleOutput === 'string' && Buffer.byteLength(item.visibleOutput) <= LIMIT ?
            item.visibleOutput.split('\n').length : null };
        if (item.callId === REMINDER_CALL) {
          observe('reminders', { itemId: item.itemId, turnId: item.turnId,
            callId: item.callId, status: item.status });
        } else observe('items', { itemId: item.itemId, turnId: item.turnId, callId: item.callId,
          tool: item.tool, status: item.status, outputShape, commandMatch: (() => {
            try { return JSON.parse(item.args)?.command === command; } catch { return false; }
          })(), outputMarkers: shellOutputMarkers(item.visibleOutput) !== null,
          workspaceReportedWritten: shellOutputMarkers(item.visibleOutput)?.workspaceWritten ?? null,
          dummyAuthVisible: shellOutputMarkers(item.visibleOutput)?.dummyAuthVisible ?? null,
          abortDenial: item.visibleOutput === 'tool denied: approval aborted' });
        if (held && item.callId === SHELL_CALL) holdEvent({ kind: 'tool_item',
          item: observations.items.at(-1) });
      }
      if (held && ['approval/resolved', 'approval/updated'].includes(notification.method)) {
        holdEvent({ kind: notification.method, approvalId: params?.approvalId,
          sessionId: params?.sessionId, turnId: params?.turnId,
          decidedByCommandId: params?.decidedByCommandId, decision: params?.decision,
          resolvedBy: params?.resolvedBy, requirementId: params?.currentRequirementId });
      }
      if (notification.method === 'turn/completed') {
        holdEvent({ kind: 'turn_completed', terminal: params?.terminal,
          turnId: params?.turnId, sessionId: params?.sessionId });
        resolveObserved({ kind: 'turn_completed', terminal: params?.terminal,
          turnId: params?.turnId, sessionId: params?.sessionId,
          errorKind: params?.error?.kind ?? null });
      }
    });
    host.onProtocolError(error => { observe('protocolErrors',
      /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'PROTOCOL_ERROR'); });
    const initialized = await timeout('initialize', host.initialize({ clientInfo: {
      name: 'passeur_guest_native_shell_probe', version: '0.1.0',
    } }));
    const nativeIdentity = await verifiedNativeNamespace(GUEST_HOME, native, namespace);
    stage = 'session_start';
    commands.push('session/start');
    const started = await timeout('session/start', initialized.connection.command('session/start',
      { workspaceRoot: workspace, modelId: SHELL_MODEL, providerId: 'meta', approvalMode: 'onRequest' },
      { maxAttempts: 1 }));
    commands.push('session/read');
    const read = await timeout('session/read', initialized.connection.command('session/read',
      { sessionId: started?.session?.sessionId, excludeItems: true }, { maxAttempts: 1 }));
    const metadata = validateIdleRead(started, read, workspace, GUEST_HOME);
    if (started.session?.approvalMode?.mode !== 'onRequest' || read.session?.approvalMode?.mode !== 'onRequest' ||
        started.session?.modelId !== SHELL_MODEL || read.session?.modelId !== SHELL_MODEL ||
        started.session?.providerId !== 'meta' || read.session?.providerId !== 'meta') {
      throw fault('NATIVE_SHELL_POSTURE_INVALID', 'native session did not retain requested model, provider and approval mode');
    }
    if (!provider.requests.some(request => request.method === 'GET' && request.path === '/muse-code/models')) {
      throw fault('NATIVE_CATALOG_MISSING', 'native host did not request guest catalog');
    }
    const ready = { kind: 'guest_shell_ready', nativeIdentity, guestNamespace: namespace,
      nativeNamespace: nativeIdentity.namespace, hostPort: config.hostPort, guestPort: provider.port,
      commandSha256: createHash('sha256').update(command).digest('hex'),
      sentinel, external, canaries, sessionDirectories, metadata, commands: [...commands],
      posture: { approvalMode: 'onRequest', modelId: SHELL_MODEL, providerId: 'meta',
        sandbox: 'native_default_no_override' },
      providerRequests: [...provider.requests] };
    process.stdout.write(`${JSON.stringify({ kind: 'guest_ready', result: ready })}\n`);
    if (await timeout('turn release', config.release()) !== 'turn') {
      throw fault('HOST_RELEASE_INVALID', 'native turn was not released by host');
    }
    stage = 'native_turn';
    commands.push('turn/start');
    const ack = await timeout('turn/start', initialized.connection.command('turn/start', {
      sessionId: metadata.sessionId,
      input: [{ type: 'text', text: readFileSchemaOnly ?
        'NATIVE_READ_FILE_SCHEMA_PROBE: Describe the advertised read_file arguments. Do not call any tool.' :
        'NATIVE_SHELL_PROBE: Use the advertised bash tool once to run the disposable command. Report its result.' }],
    }, { maxAttempts: 1 }));
    if (ack.status !== 'accepted' || ack.disposition !== 'started' || ack.startedNewTurn !== true ||
        typeof ack.turnId !== 'string') {
      throw fault('NATIVE_TURN_ACK_INVALID', 'native turn was not admitted as one fresh turn');
    }
    const event = await timeout('native turn or approval', Promise.race([observed, provider.rejection]), 15_000);
    if (event.kind === 'provider_rejected') {
      throw fault(event.code, 'guest provider rejected the native Responses request');
    }
    if (provider.state.primaryCode) {
      throw fault(provider.state.primaryCode, 'guest provider rejected the native Responses request');
    }
    if (event.kind === 'turn_completed' && provider.state.main !==
        (readFileSchemaOnly ? 'schema-observed' : 'result-accepted')) {
      const late = await Promise.race([provider.rejection, pause(500).then(() => null)]);
      if (late) throw fault(late.code, 'guest provider rejected the native Responses request');
      throw fault('NATIVE_TOOL_RESULT_MISSING', 'native turn ended without a correlated bash result');
    }
    let pending = null;
    if (readFileSchemaOnly && event.kind !== 'turn_completed') {
      throw fault('NATIVE_READ_FILE_SCHEMA_EVENT_INVALID', 'schema-only turn requested an approval or tool');
    }
    if (event.kind === 'approval') {
      pending = await timeout('approval/listPending', initialized.connection.request('approval/listPending',
        { sessionId: metadata.sessionId }));
      if (!Array.isArray(pending?.approvals) || !Array.isArray(pending?.userInputs) ||
          pending.userInputs.length !== 0 || pending.approvals.length !== 1 ||
          pending.approvals[0].approvalId !== event.approval.approvalId) {
        throw fault('NATIVE_APPROVAL_INVALID', 'read-only pending list differs from observed approval');
      }
    }
    let heldResult = null;
    if (held && event.kind === 'approval') {
      validateHeldInitialApproval(metadata, ack, event, pending, command);
      const presentation = heldApprovalPresentation(pending.approvals[0], command,
        workspace, config.protectedRoot, config.canaryToken);
      if (JSON.stringify(presentation.approval) !== JSON.stringify(event.approval) ||
          observations.approvals.length !== 1) {
        throw fault('NATIVE_HELD_APPROVAL_STALE', 'held approval differed before presentation');
      }
      process.stdout.write(`${JSON.stringify({ kind: 'guest_handoff', result: presentation })}\n`);
      const line = await timeout('held human input', config.release(), HELD_WAIT_MS + 5_000);
      let input;
      try { input = JSON.parse(line); }
      catch { throw fault('NATIVE_HELD_INPUT_INVALID', 'held input was not JSON'); }
      if (input?.kind === 'expire' && Object.keys(input).join(',') === 'kind') {
        heldResult = { kind: 'expired', presentation };
      } else {
        if (provider.state.primaryCode) throw fault(provider.state.primaryCode, 'provider rejected before human choice');
        const decision = await submitHeldDecision(initialized.connection, presentation,
          input, command, { submitted: false });
        let cursor = 0;
        const next = async predicate => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            if (provider.state.primaryCode) throw fault(provider.state.primaryCode, 'provider rejected held native request');
            if (heldEventOverflow) throw fault('NATIVE_HELD_EVENT_BUDGET', 'native held event count exceeded bound');
            if (observations.approvals.length > 1) {
              throw fault('NATIVE_HELD_ADDITIONAL_APPROVAL', 'another native approval needs a separate human choice');
            }
            while (cursor < heldEvents.length) {
              const value = heldEvents[cursor++];
              if (predicate(value)) return value;
            }
            await pause(10);
          }
          throw fault('NATIVE_HELD_RESOLUTION_MISSING', 'native approval did not reach an authoritative outcome');
        };
        const resolved = await next(value => ['approval/resolved', 'approval/updated'].includes(value.kind));
        if (resolved.approvalId !== presentation.approval.approvalId ||
            resolved.sessionId !== metadata.sessionId ||
            (resolved.kind === 'approval/resolved' &&
              (resolved.turnId !== ack.turnId || resolved.decidedByCommandId !== decision.commandId ||
               resolved.decision !== decision.choice.decision || resolved.resolvedBy !== 'user'))) {
          throw fault('NATIVE_HELD_RESOLUTION_INVALID', 'native approval resolution differed from submitted choice');
        }
        if (resolved.kind === 'approval/updated' || decision.ack.terminal !== true) {
          throw fault('NATIVE_HELD_ADDITIONAL_APPROVAL', 'native approval advanced to another requirement');
        }
        const item = await next(value => value.kind === 'tool_item');
        const terminal = await next(value => value.kind === 'turn_completed');
        if (item.item.callId !== SHELL_CALL || item.item.turnId !== ack.turnId ||
            terminal.turnId !== ack.turnId || terminal.sessionId !== metadata.sessionId) {
          throw fault('NATIVE_HELD_TURN_INVALID', 'native tool or turn differed from approved call');
        }
        heldResult = { kind: 'decided', presentation, decision, resolved, item: item.item, terminal };
      }
    }
    await timeout('provider freeze', provider.freeze(), 5_000);
    if (provider.state.primaryCode) {
      throw fault(provider.state.primaryCode, 'guest provider rejected a request before outcome publication');
    }
    const result = { kind: readFileSchemaOnly ? 'native_read_file_schema_outcome' :
      heldResult?.kind === 'decided' ? 'native_shell_held_decided' :
      event.kind === 'approval' ? 'native_shell_approval_pending' : 'guest_shell_outcome',
      stage, sessionId: metadata.sessionId, turnId: ack.turnId, turnAck: { status: ack.status,
        disposition: ack.disposition, startedNewTurn: ack.startedNewTurn }, event,
      pending: pending ? { approvals: pending.approvals.map(approval => approvalSummary(approval, command)),
        userInputs: [] } : null,
      observations, providerRequests: [...provider.requests], commands: [...commands],
      ...(heldResult ? { held: heldResult } : {}) };
    process.stdout.write(`${JSON.stringify({ kind: 'guest_outcome', result })}\n`);
    if (await timeout('shutdown release', config.release()) !== 'shutdown') {
      throw fault('HOST_RELEASE_INVALID', 'native shutdown was not released by host');
    }
    await timeout('host close', host.close(), 5_000);
    host = undefined;
    if (provider.state.primaryCode) {
      throw fault(provider.state.primaryCode, 'guest provider rejected a request during native shutdown');
    }
    if (JSON.stringify(provider.requests) !== JSON.stringify(result.providerRequests)) {
      throw fault('NATIVE_PROVIDER_AFTER_FREEZE', 'provider evidence changed after admission closed');
    }
    return result;
  } catch (error) {
    return { kind: 'guest_transport_error', stage, code: error.code ?? error.name,
      message: String(error.message).slice(0, 400), guestNamespace: namespace,
      commands, providerRequests: provider?.requests ?? [], observations };
  } finally {
    try { if (host) await timeout('host close', host.close(), 5_000); } catch { /* stop is verified outside */ }
    try { if (provider) await provider.close(); } catch { /* retain fixture */ }
  }
}

async function runCaptured(command, args, { input = '', budgetMs = DEADLINE_MS } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    let output = '';
    let errorOutput = '';
    let overflow = false;
    let timedOut = false;
    let hardStop;
    const stop = () => {
      child.kill('SIGTERM');
      hardStop ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, budgetMs);
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > LIMIT) { overflow = true; stop(); }
      return next.slice(0, LIMIT);
    };
    child.stdout.on('data', chunk => { output = append(output, chunk); });
    child.stderr.on('data', chunk => { errorOutput = append(errorOutput, chunk); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardStop);
      resolveResult({ code: null, error: error.code ?? error.name, output, errorOutput }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(hardStop);
      resolveResult({ code, signal, timedOut, overflow, output, errorOutput });
    });
    child.stdin.end(input);
  });
}

export async function stageRuntime(root, muse, { copy = copyFile, copyTree = cp,
  resolveBinary = pinnedBinary, resolveNode = pinnedNode, hash = digest } = {}) {
  const native = await resolveBinary(muse);
  const runtime = join(root, 'runtime');
  const packageRoot = resolve('node_modules/@muse-code/sdk');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== SDK_VERSION || packageJson.engines?.node !== '>=20' ||
      Object.keys(packageJson.dependencies ?? {}).length !== 0) {
    throw fault('SDK_MISMATCH', 'local SDK version or runtime dependency set differs from pinned package');
  }
  await mkdir(join(runtime, 'sdk'), { recursive: true, mode: 0o700 });
    await copy(fileURLToPath(import.meta.url), join(runtime, 'qualify-muse-sandbox-transport.mjs'));
    await copy(resolve('scripts/experiment-worker-sandbox.mjs'), join(runtime, 'experiment-worker-sandbox.mjs'));
  await copyTree(join(packageRoot, 'dist'), join(runtime, 'sdk', 'dist'), { recursive: true });
  await copy(join(packageRoot, 'package.json'), join(runtime, 'sdk', 'package.json'));
  await copy(native, join(runtime, `muse-bin-${VERSION}`));
  await writeFile(join(runtime, 'native-host-wrapper'), `#!/bin/sh\nset -eu\ncat /proc/$$/stat > ${GUEST_HOME}/native.stat\nreadlink /proc/$$/ns/net > ${GUEST_HOME}/native.netns\nexec ${GUEST_RUNTIME}/muse-bin-${VERSION} "$@"\n`, { mode: 0o700 });
  if (await hash(join(runtime, `muse-bin-${VERSION}`)) !== NATIVE_SHA256) {
    throw fault('NATIVE_BINARY_MISMATCH', 'staged Muse binary digest differs from pinned identity');
  }
  const node = await resolveNode();
  await copy(node, join(runtime, 'node'));
  const stagedNode = join(runtime, 'node');
  const nodeEntry = await lstat(stagedNode);
  if (await hash(stagedNode) !== NODE_SHA256 ||
      !nodeEntry.isFile() || (nodeEntry.mode & 0o111) === 0) {
    throw fault('NODE_BINARY_MISMATCH', 'staged Node binary digest, type or executable mode differs from pinned identity');
  }
  return runtime;
}

export function retainHostRoot(hostStarted) { return hostStarted; }

function hostStat(raw) {
  const identity = procIdentity(raw);
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  if (!Number.isSafeInteger(parent)) throw fault('STOP_IDENTITY_INVALID', 'process parent was invalid');
  return { ...identity, parent };
}

async function processIdentity(pid, boot) {
  const base = `/proc/${pid}`;
  const [stat, exe, pidns, netns, status] = await Promise.all([
    readFile(`${base}/stat`, 'utf8'), readlink(`${base}/exe`), readlink(`${base}/ns/pid`),
    readlink(`${base}/ns/net`), readFile(`${base}/status`, 'utf8'),
  ]);
  const identity = hostStat(stat);
  if (identity.pid !== pid || ['Z', 'X'].includes(identity.state)) throw fault('STOP_IDENTITY_INVALID', 'process identity changed');
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  if (!nspid?.length || nspid.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw fault('STOP_IDENTITY_INVALID', 'namespace PID mapping was unavailable');
  }
  return { ...identity, boot, exe, pidns, netns, nspid };
}

export function parseBubblewrapStatus(lines) {
  const known = { child: null, exit: null };
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { throw fault('BWRAP_STATUS_INVALID', 'malformed Bubblewrap status JSON'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw fault('BWRAP_STATUS_INVALID', 'invalid Bubblewrap status event');
    if (Object.hasOwn(event, 'child-pid')) {
      if (known.child !== null || !Number.isSafeInteger(event['child-pid']) || event['child-pid'] < 1 || known.exit !== null) {
        throw fault('BWRAP_STATUS_INVALID', 'duplicate or invalid Bubblewrap child PID');
      }
      known.child = event['child-pid'];
    }
    if (Object.hasOwn(event, 'exit-code')) {
      if (known.child === null || known.exit !== null || !Number.isSafeInteger(event['exit-code']) || event['exit-code'] < 0) {
        throw fault('BWRAP_STATUS_INVALID', 'duplicate or invalid Bubblewrap exit code');
      }
      known.exit = event['exit-code'];
    }
  }
  return known;
}

async function namespaceMembers(pidns, boot) {
  const entries = await readdir('/proc');
  const members = [];
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let namespace;
    try { namespace = await readlink(`/proc/${entry}/ns/pid`); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw fault('STOP_SCAN_INCOMPLETE', `PID namespace scan could not inspect ${entry}: ${error.code ?? error.name}`); }
    if (namespace === pidns) {
      try { members.push(await processIdentity(Number(entry), boot)); }
      catch (error) { throw fault('STOP_SCAN_INCOMPLETE', `namespace member ${entry} could not be inspected: ${error.code ?? error.name}`); }
    }
  }
  return members;
}

export async function captureHostIdentities(wrapperPid, childPid, nativeStart, nativeExe, supervisorExe) {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const wrapper = await processIdentity(wrapperPid, boot);
  const statusChild = await processIdentity(childPid, boot);
  if (statusChild.pidns === wrapper.pidns || statusChild.netns === wrapper.netns) {
    throw fault('STOP_ASSOCIATION_INVALID', 'Bubblewrap child is not in the new namespaces');
  }
  const fd = await open(`/proc/${statusChild.pid}/ns/pid`, 'r');
  try {
    const pinned = await readlink(`/proc/self/fd/${fd.fd}`);
    if (pinned !== statusChild.pidns) throw fault('STOP_ASSOCIATION_INVALID', 'held namespace descriptor differs');
    const members = await namespaceMembers(pinned, boot);
    const { init, supervisor, native } = assertHostAssociation(wrapper, statusChild, members,
      nativeStart, nativeExe, supervisorExe);
    return { fd, boot, wrapper, statusChild, supervisor, init, native, members, pidns: pinned };
  } catch (error) { await fd.close(); throw error; }
}

export function assertHostAssociation(wrapper, statusChild, members, nativeStart, nativeExe, supervisorExe) {
  if (statusChild.pidns === wrapper.pidns || statusChild.netns === wrapper.netns) {
    throw fault('STOP_ASSOCIATION_INVALID', 'Bubblewrap child is not in the new namespaces');
  }
  const init = members.filter(member => member.nspid?.at(-1) === 1);
  const native = members.filter(member => member.exe === nativeExe && member.start === nativeStart);
  const supervisor = members.filter(member => member.exe === supervisorExe);
  const observedChild = members.find(member => member.pid === statusChild.pid);
  if (init.length !== 1 || init[0].parent !== wrapper.pid || native.length !== 1 ||
      supervisor.length !== 1 || native[0].netns !== supervisor[0].netns ||
      !observedChild || observedChild.start !== statusChild.start ||
      observedChild.parent !== statusChild.parent || observedChild.exe !== statusChild.exe ||
      observedChild.pidns !== statusChild.pidns || observedChild.netns !== statusChild.netns) {
    throw fault('STOP_ASSOCIATION_INVALID', 'unique namespace init, supervisor or native was absent');
  }
  const byPid = new Map(members.map(member => [member.pid, member]));
  const descendsFrom = (process, target) => {
    let ancestor = process;
    const seen = new Set();
    while (ancestor.pid !== target.pid && byPid.has(ancestor.parent) && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid);
      ancestor = byPid.get(ancestor.parent);
    }
    return ancestor.pid === target.pid;
  };
  if (!descendsFrom(statusChild, init[0]) || !descendsFrom(supervisor[0], init[0]) ||
      !descendsFrom(native[0], supervisor[0])) {
    throw fault('STOP_ASSOCIATION_INVALID', 'Bubblewrap child or native ancestry differs from namespace init');
  }
  return { init: init[0], supervisor: supervisor[0], native: native[0] };
}

export async function verifyHostStop(capture, status, exit, {
  bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'),
  scan = namespaceMembers,
} = {}) {
  const boot = await bootId();
  if (boot !== capture.boot) throw fault('STOP_IDENTITY_INVALID', 'host boot changed during diagnostic');
  if (status.child !== capture.statusChild.pid || status.exit !== 0 || exit.code !== 0 || exit.signal !== null ||
      exit.timedOut || exit.overflow || !exit.statusClosed) {
    throw fault('STOP_STATUS_INVALID', 'Bubblewrap status, closure or wrapper exit did not confirm clean stop');
  }
  for (const observed of [capture.wrapper, ...capture.members]) {
    let stat;
    try { stat = hostStat(await readStat(observed.pid)); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    if (stat.start !== observed.start) throw fault('STOP_PID_REUSED', `observed PID ${observed.pid} was reused`);
    throw fault('STOP_SURVIVOR', `observed PID ${observed.pid} remains present`);
  }
  if ((await scan(capture.pidns, boot)).length !== 0) {
    throw fault('STOP_SURVIVOR', 'a process remains in the held PID namespace');
  }
  return { kind: 'confirmed', boot, pidns: capture.pidns, observed: capture.members.length + 1 };
}

export function runStatusPhase(prepared, config) {
  const separator = prepared.args.indexOf('--');
  if (separator < 0) throw fault('BWRAP_STATUS_INVALID', 'prepared sandbox lacks command delimiter');
  const args = [...prepared.args.slice(0, separator), '--json-status-fd', '3', ...prepared.args.slice(separator)];
  const child = spawn(prepared.executable, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {} });
  const output = [];
  const statusLines = [];
  let stderr = '';
  let statusClosed = false;
  let overflow = false;
  let timedOut = false;
  let readyResolve;
  let readyReject;
  let outcomeResolve;
  let outcomeReject;
  let handoffResolve;
  let handoffReject;
  let statusResolve;
  let statusReject;
  let released = false;
  let shutdownReleased = false;
  let decisionSent = false;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const outcome = new Promise((resolveValue, rejectValue) => { outcomeResolve = resolveValue; outcomeReject = rejectValue; });
  const handoff = new Promise((resolveValue, rejectValue) => { handoffResolve = resolveValue; handoffReject = rejectValue; });
  const liveStatus = new Promise((resolveStatus, rejectStatus) => { statusResolve = resolveStatus; statusReject = rejectStatus; });
  // Both promises have consumers from construction, including on early spawn failure.
  ready.catch(() => undefined);
  outcome.catch(() => undefined);
  handoff.catch(() => undefined);
  liveStatus.catch(() => undefined);
  const append = (array, line) => {
    array.push(line);
    if (Buffer.byteLength(array.join('\n')) > LIMIT) { overflow = true; child.kill('SIGTERM'); }
  };
  for (const stream of [child.stdout, child.stdio[3]]) {
    let bytes = 0;
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > LIMIT) { overflow = true; stream.destroy(); child.kill('SIGTERM'); }
    });
  }
  createInterface({ input: child.stdout }).on('line', line => {
    append(output, line);
    if (['first', 'resume', 'shell', 'held-shell', 'read-file-schema'].includes(config.phase) && output.length === 1) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind !== 'guest_ready' || parsed.result?.kind !==
            (config.phase === 'first' ? 'guest_transport_observed' :
              config.phase === 'resume' ? 'guest_resume_observed' : 'guest_shell_ready')) {
          throw fault('GUEST_OUTPUT_INVALID', 'first phase readiness was invalid');
        }
        readyResolve(parsed.result);
      } catch (error) { readyReject(error); }
    }
    if (config.phase === 'held-shell' && output.length === 2) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === 'guest_transport_error') {
          const failure = decodeShellOutcomeLine(line);
          handoffResolve(failure);
          outcomeResolve(failure);
          return;
        }
        if (parsed.kind !== 'guest_handoff' || parsed.result?.kind !== 'native_shell_live_approval') {
          throw fault('NATIVE_HELD_HANDOFF_INVALID', 'guest did not present a live native approval');
        }
        handoffResolve(parsed.result);
      } catch (error) { handoffReject(error); }
    }
    if ((['shell', 'read-file-schema'].includes(config.phase) && output.length === 2) ||
        (config.phase === 'held-shell' && output.length === 3)) {
      try {
        outcomeResolve(decodeShellOutcomeLine(line));
      } catch (error) { outcomeReject(error); }
    }
  });
  createInterface({ input: child.stdio[3] }).on('line', line => {
    append(statusLines, line);
    try { const status = parseBubblewrapStatus(statusLines); if (status.child) statusResolve(status); }
    catch (error) { statusReject(error); }
  });
  child.stdio[3].on('end', () => { statusClosed = true; });
  child.stderr.on('data', chunk => {
    if (Buffer.byteLength(stderr) + chunk.length > LIMIT) { overflow = true; child.kill('SIGTERM'); }
    stderr = (stderr + chunk.toString()).slice(0, LIMIT);
  });
  child.stdin.on('error', () => { /* child completion reports the failed phase */ });
  child.stdin.write(`${JSON.stringify(config)}\n`);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref(); },
  config.phase === 'held-shell' ? HELD_DEADLINE_MS : DEADLINE_MS);
  const finished = new Promise(resolveResult => {
    child.once('error', error => {
      clearTimeout(timer);
      readyReject(error);
      outcomeReject(error);
      handoffReject(error);
      statusReject(error);
      resolveResult({ code: null, signal: null, error: error.code ?? error.name, timedOut, overflow,
        output, stderr, statusLines, statusClosed });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (output.length === 0) readyReject(fault('GUEST_OUTPUT_INVALID', 'phase exited before readiness'));
      if (['shell', 'read-file-schema'].includes(config.phase) && output.length < 2 ||
          config.phase === 'held-shell' && output.length < 3) {
        outcomeReject(fault('GUEST_OUTPUT_INVALID', 'shell exited before outcome'));
      }
      if (config.phase === 'held-shell' && output.length < 2) {
        handoffReject(fault('NATIVE_HELD_HANDOFF_MISSING', 'held shell exited before approval handoff'));
      }
      if (statusLines.length === 0) statusReject(fault('BWRAP_STATUS_INVALID', 'Bubblewrap exited without status'));
      resolveResult({ code, signal, timedOut, overflow, output, stderr, statusLines, statusClosed });
    });
  });
  const boundedOutcome = ['shell', 'held-shell', 'read-file-schema'].includes(config.phase) ?
    timeout('shell outcome', outcome, config.phase === 'held-shell' ? HELD_DEADLINE_MS : DEADLINE_MS) : undefined;
  boundedOutcome?.catch(() => undefined);
  const boundedHandoff = config.phase === 'held-shell' ? timeout('held approval handoff', handoff) : undefined;
  boundedHandoff?.catch(() => undefined);
  return { pid: child.pid, ready: timeout('host readiness', ready),
    outcome: boundedOutcome,
    handoff: boundedHandoff,
    liveStatus: timeout('live Bubblewrap status', liveStatus),
    statusLines: () => [...statusLines],
    release: () => { if (!released) { released = true; child.stdin.end('release\n'); } },
    releaseTurn: () => { if (['shell', 'held-shell', 'read-file-schema'].includes(config.phase) && !released) {
      released = true; child.stdin.write('turn\n'); } },
    sendDecision: decision => { if (config.phase !== 'held-shell' || !released || decisionSent) {
      throw fault('NATIVE_HELD_DECISION_SEQUENCE', 'held decision was sent outside its one-use window');
    }
      decisionSent = true;
      child.stdin.write(`${JSON.stringify(decision)}\n`);
    },
    releaseShutdown: () => { if (['shell', 'held-shell', 'read-file-schema'].includes(config.phase) && released && !shutdownReleased) {
      shutdownReleased = true; child.stdin.end('shutdown\n');
    } },
    abort: () => { if (!shutdownReleased) { shutdownReleased = true; child.stdin.end(); } }, finished };
}

export function decodeShellOutcomeLine(line) {
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { throw fault('GUEST_OUTPUT_INVALID', 'shell outcome JSON invalid'); }
  if (parsed?.kind === 'guest_outcome' &&
      ['guest_shell_outcome', 'native_read_file_schema_outcome', 'native_shell_approval_pending',
        'native_shell_held_decided'].includes(parsed.result?.kind)) return parsed.result;
  if (parsed?.kind === 'guest_transport_error' && parsed.stage === 'native_turn' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code ?? '') &&
      typeof parsed.message === 'string' && Buffer.byteLength(parsed.message) <= 400 &&
      Array.isArray(parsed.providerRequests)) return parsed;
  throw fault('GUEST_OUTPUT_INVALID', 'shell outcome framing invalid');
}

function validatePhaseOutcome(phase, guest) {
    const requests = guest?.providerRequests;
    const canaries = guest?.canaries;
    if (guest?.kind !== (phase === 'first' ? 'guest_transport_observed' : 'guest_resume_observed') ||
        typeof guest.guestNamespace !== 'string' || !/^net:\[\d+\]$/.test(guest.guestNamespace) ||
        guest.nativeNamespace !== guest.guestNamespace ||
        !['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(guest.sentinel?.code) ||
        guest.sentinel?.kind !== 'error' || !classifyNoRoute(guest.external) ||
        !Number.isSafeInteger(guest.hostPort) || !Number.isSafeInteger(guest.guestPort) ||
        guest.hostPort < 1 || guest.guestPort < 1 || guest.hostPort === guest.guestPort ||
        !canaries || Object.keys(canaries).sort().join(',') !== 'directAbsent,procAbsent,symlinkAbsent' ||
        Object.values(canaries).some(value => value !== true) || guest.nativeCatalogGet !== true ||
        !Array.isArray(requests) || requests.filter(request =>
          request.method === 'GET' && request.path === '/muse-code/models').length < 1 ||
        typeof guest.metadata?.viewCursor !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guest.metadata?.sessionId ?? '') ||
        guest.metadata?.history !== 'none' || guest.metadata?.status !== 'idle' ||
        guest.metadata?.turnCount !== 0 || guest.metadata?.activeTurnId !== null ||
        guest.metadata?.pendingCount !== 0) {
      throw fault('PHASE_OUTCOME_INVALID', `${phase} guest boundary or catalog evidence invalid`);
    }
    if (requests.some(request => !(request.method === 'GET' && request.path === '/muse-code/models') &&
        !(phase === 'first' && request.method === 'POST' && request.path === '/responses' &&
          request.directMarker === true))) {
      throw fault('PHASE_OUTCOME_INVALID', `${phase} provider made an unallowed request`);
    }
    assertNoTurn(guest.commands, phase === 'first'
      ? requests.filter(request => request.path !== '/responses') : requests);
    if (phase === 'first' && (guest.commands[0] !== 'session/start' ||
        guest.directResponses?.attribution !== 'direct_guest_client_text_only' ||
        guest.directResponses.status !== 200 || guest.nativeTurnSubmitted !== false ||
        requests.filter(request => request.path === '/responses').length !== 1)) {
      throw fault('PHASE_OUTCOME_INVALID', 'first phase direct-client attribution invalid');
    }
    if (phase === 'resume' && (guest.commands[0] !== 'session/resume' ||
        requests.some(request => request.path === '/responses'))) {
      throw fault('PHASE_OUTCOME_INVALID', 'resume phase made an unallowed provider request');
    }
    if (phase === 'resume' && (!guest.resumeMetadata ||
        guest.resumeMetadata.sessionId !== guest.metadata.sessionId ||
        guest.resumeMetadata.workspaceRoot !== guest.metadata.workspaceRoot ||
        guest.resumeMetadata.durableLogPath !== guest.metadata.durableLogPath ||
        guest.resumeMetadata.status !== 'idle' || guest.resumeMetadata.turnCount !== 0 ||
        guest.resumeMetadata.activeTurnId !== null || guest.resumeMetadata.pendingCount !== 0 ||
        guest.resumeMetadata.history !== 'none' || typeof guest.resumeMetadata.viewCursor !== 'string')) {
      throw fault('PHASE_OUTCOME_INVALID', 'resume envelope was not idle metadata for the original session');
    }
}

export function validateResumeOutcome(first, second, workspace, home) {
  validatePhaseOutcome('first', first);
  validatePhaseOutcome('resume', second);
  if (first.metadata?.sessionId !== second.metadata?.sessionId ||
      first.metadata?.workspaceRoot !== workspace || second.metadata?.workspaceRoot !== workspace ||
      first.metadata?.durableLogPath !== second.metadata?.durableLogPath ||
      !first.metadata.durableLogPath.startsWith(`${home}/.local/share/muse/sessions/`) ||
      first.metadata.turnCount !== 0 || second.metadata.turnCount !== 0 ||
      first.metadata.activeTurnId !== null || second.metadata.activeTurnId !== null ||
      first.metadata.pendingCount !== 0 || second.metadata.pendingCount !== 0 ||
      first.metadata.history !== 'none' || second.metadata.history !== 'none' ||
      first.metadata.status !== 'idle' || second.metadata.status !== 'idle' ||
      first.hostPort !== second.hostPort ||
      first.guestNamespace === second.guestNamespace) {
    throw fault('RESUME_IDENTITY_INVALID', 'second host did not preserve idle durable session identity');
  }
  return { sessionId: first.metadata.sessionId, durableLogPath: first.metadata.durableLogPath };
}

export async function qualifyFreshHostResume({ muse = '/home/jeremy/.local/bin/muse',
  checkBubblewrap = probeBubblewrap, stage = stageRuntime, startSentinel = startHostSentinel,
  probe = tcpProbe, launch = runStatusPhase, capture = captureHostIdentities,
  stop = verifyHostStop } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-fresh-resume-'));
  let sentinel;
  let firstHost;
  let secondHost;
  let firstCapture;
  let secondCapture;
  let stageName = 'stage';
  let outcome;
  const evidence = {};
  try {
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const token = 'protected-canary';
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(protectedRoot)]);
    await writeFile(join(protectedRoot, token), 'host-only');
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(root, muse);
    sentinel = await startSentinel();
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable before first host');
    }
    const prepared = prepareSandbox(sandboxConfig({ workspace, runtime, home, protectedRoot }), guestCommand());
    checkBubblewrap();
    stageName = 'first_host';
    firstHost = launch(prepared, { phase: 'first', workspace, hostPort: sentinel.port, protectedRoot, canaryToken: token });
    const [firstReady, firstStatus] = await Promise.all([firstHost.ready, firstHost.liveStatus]);
    evidence.firstReady = firstReady;
    evidence.firstLiveStatus = firstStatus;
    validatePhaseOutcome('first', firstReady);
    if (firstReady.hostPort !== sentinel.port || firstReady.kind !== 'guest_transport_observed' ||
        firstReady.metadata?.status !== 'idle' || firstReady.metadata?.turnCount !== 0 ||
        firstReady.metadata?.pendingCount !== 0 ||
        firstReady.metadata?.workspaceRoot !== workspace ||
        firstReady.metadata?.history !== 'none' ||
        firstReady.metadata?.activeTurnId !== null ||
        typeof firstReady.metadata?.sessionId !== 'string' ||
        typeof firstReady.metadata?.durableLogPath !== 'string' ||
        !firstReady.metadata.durableLogPath.startsWith(`${GUEST_HOME}/.local/share/muse/sessions/`)) {
      throw fault('PHASE_OUTCOME_INVALID', 'first guest idle metadata invalid before resume admission');
    }
    if (!firstStatus.child || firstStatus.exit !== null) throw fault('BWRAP_STATUS_INVALID', 'live first host status missing child');
    firstCapture = await capture(firstHost.pid, firstStatus.child, firstReady.nativeIdentity.start,
      `${GUEST_RUNTIME}/muse-bin-${VERSION}`, `${GUEST_RUNTIME}/node`);
    evidence.firstCapture = { boot: firstCapture.boot, pidns: firstCapture.pidns,
      wrapper: firstCapture.wrapper, statusChild: firstCapture.statusChild,
      init: firstCapture.init, supervisor: firstCapture.supervisor, native: firstCapture.native,
      memberCount: firstCapture.members?.length };
    if (firstCapture.native.nspid.at(-1) !== firstReady.nativeIdentity.pid ||
        firstCapture.native.netns !== firstReady.nativeNamespace ||
        firstCapture.supervisor.netns !== firstReady.guestNamespace) {
      throw fault('STOP_ASSOCIATION_INVALID', 'guest native marker differs from host observation');
    }
    firstHost.release();
    const firstDone = await timeout('first host exit', firstHost.finished, DEADLINE_MS + 3_000);
    evidence.firstExit = { code: firstDone.code, signal: firstDone.signal, timedOut: firstDone.timedOut,
      overflow: firstDone.overflow, statusClosed: firstDone.statusClosed };
    const firstTerminal = parseBubblewrapStatus(firstDone.statusLines);
    evidence.firstTerminal = firstTerminal;
    if (firstDone.output.length !== 2 || firstDone.code !== 0 || firstDone.timedOut || firstDone.overflow ||
        JSON.stringify(JSON.parse(firstDone.output[1])) !== JSON.stringify(firstReady)) {
      throw fault('GUEST_OUTPUT_INVALID', 'first phase terminal output differs from held readiness');
    }
    const firstStop = await timeout('first host stop scan', stop(firstCapture, firstTerminal, firstDone));
    evidence.firstStop = firstStop;
    await firstCapture.fd.close(); firstCapture = undefined;
    if (firstStop.kind !== 'confirmed') throw fault('STOP_UNCONFIRMED', 'first namespace stop was not confirmed');
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable at second-host gate');
    }
    const logRelative = relative(GUEST_HOME, firstReady.metadata.durableLogPath);
    if (resolve(GUEST_HOME, logRelative) !== firstReady.metadata.durableLogPath ||
        logRelative.startsWith('..')) {
      throw fault('RESUME_IDENTITY_INVALID', 'durable log path was not canonical inside private HOME');
    }
    const hostLog = join(home, logRelative);
    const firstLog = await lstat(hostLog);
    if (!firstLog.isFile()) throw fault('RESUME_IDENTITY_INVALID', 'first durable log is not a regular file');
    stageName = 'second_host';
    secondHost = launch(prepared, { phase: 'resume', workspace, hostPort: sentinel.port,
      protectedRoot, canaryToken: token, sessionId: firstReady.metadata.sessionId,
      logPath: firstReady.metadata.durableLogPath });
    const [secondReady, secondLive] = await Promise.all([secondHost.ready, secondHost.liveStatus]);
    evidence.secondReady = secondReady;
    evidence.secondLiveStatus = secondLive;
    if (secondReady.hostPort !== sentinel.port) {
      throw fault('PHASE_OUTCOME_INVALID', 'second guest did not probe the original host sentinel');
    }
    if (!secondLive.child || secondLive.exit !== null) throw fault('BWRAP_STATUS_INVALID', 'live second host status missing child');
    secondCapture = await capture(secondHost.pid, secondLive.child, secondReady.nativeIdentity.start,
      `${GUEST_RUNTIME}/muse-bin-${VERSION}`, `${GUEST_RUNTIME}/node`);
    evidence.secondCapture = { boot: secondCapture.boot, pidns: secondCapture.pidns,
      wrapper: secondCapture.wrapper, statusChild: secondCapture.statusChild,
      init: secondCapture.init, supervisor: secondCapture.supervisor, native: secondCapture.native,
      memberCount: secondCapture.members?.length };
    if (secondCapture.native.nspid.at(-1) !== secondReady.nativeIdentity.pid ||
        secondCapture.native.netns !== secondReady.nativeNamespace ||
        secondCapture.supervisor.netns !== secondReady.guestNamespace ||
        secondCapture.pidns === firstStop.pidns || secondCapture.boot !== firstStop.boot) {
      throw fault('STOP_ASSOCIATION_INVALID', 'second native host was not fresh or its marker differed');
    }
    secondHost.release();
    const secondDone = await timeout('second host exit', secondHost.finished, DEADLINE_MS + 3_000);
    evidence.secondExit = { code: secondDone.code, signal: secondDone.signal, timedOut: secondDone.timedOut,
      overflow: secondDone.overflow, statusClosed: secondDone.statusClosed };
    const secondStatus = parseBubblewrapStatus(secondDone.statusLines);
    evidence.secondTerminal = secondStatus;
    if (secondDone.output.length !== 2 || secondDone.code !== 0 || secondDone.timedOut || secondDone.overflow ||
        JSON.stringify(JSON.parse(secondDone.output[1])) !== JSON.stringify(secondReady)) {
      throw fault('GUEST_OUTPUT_INVALID', 'second phase terminal output invalid');
    }
    const resumed = validateResumeOutcome(firstReady, secondReady, workspace, GUEST_HOME);
    const secondLog = await lstat(hostLog);
    if (!secondLog.isFile() || secondLog.dev !== firstLog.dev || secondLog.ino !== firstLog.ino) {
      throw fault('RESUME_IDENTITY_INVALID', 'durable log inode changed across native hosts');
    }
    const secondStop = await timeout('second host stop scan', stop(secondCapture, secondStatus, secondDone));
    evidence.secondStop = secondStop;
    await secondCapture.fd.close(); secondCapture = undefined;
    if (secondStop.kind !== 'confirmed') throw fault('STOP_UNCONFIRMED', 'second namespace stop was not confirmed');
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable after second host');
    }
    outcome = { kind: 'fresh_host_idle_resume_observed', resumed, first: firstReady, second: secondReady,
      firstStop, secondStop, evidence };
  } catch (error) {
    outcome = { kind: 'fresh_host_idle_resume_error', stage: stageName,
      code: error.code ?? error.name, message: String(error.message).slice(0, 500),
      stopProof: 'unconfirmed', evidence };
  } finally {
    if (firstHost) firstHost.release();
    if (secondHost) secondHost.release();
    for (const [name, host] of [['first', firstHost], ['second', secondHost]]) if (host) {
      try {
        const completed = await timeout('sandbox shutdown', host.finished, DEADLINE_MS + 3_000);
        evidence[`${name}Completion`] = { code: completed.code, signal: completed.signal,
          timedOut: completed.timedOut, overflow: completed.overflow, statusClosed: completed.statusClosed,
          statusLines: completed.statusLines, output: completed.output, stderr: completed.stderr };
      }
      catch { /* retained root and unconfirmed stop */ }
    }
    if (firstCapture) await firstCapture.fd.close();
    if (secondCapture) await secondCapture.fd.close();
    if (sentinel) try { await sentinel.close(); } catch { /* retained root */ }
  }
  outcome.retainedFixtures = [root];
  return outcome;
}

export function validateShellReady(ready, workspace, sentinelPort) {
  if (ready?.kind !== 'guest_shell_ready' || ready.hostPort !== sentinelPort ||
      !Number.isSafeInteger(ready.guestPort) || ready.guestPort === sentinelPort ||
      ready.guestNamespace !== ready.nativeNamespace ||
      !/^net:\[\d+\]$/.test(ready.guestNamespace ?? '') ||
      !/^[0-9a-f]{64}$/.test(ready.commandSha256 ?? '') ||
      ready.sentinel?.kind !== 'error' ||
      !['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(ready.sentinel.code) ||
      !classifyNoRoute(ready.external) ||
      Object.keys(ready.canaries ?? {}).sort().join(',') !== 'directAbsent,procAbsent,symlinkAbsent' ||
      Object.values(ready.canaries).some(value => value !== true) ||
      ready.metadata?.workspaceRoot !== workspace || ready.metadata?.status !== 'idle' ||
      ready.metadata?.turnCount !== 0 || ready.metadata?.activeTurnId !== null ||
      ready.metadata?.pendingCount !== 0 || ready.metadata?.history !== 'none' ||
      ready.posture?.approvalMode !== 'onRequest' || ready.posture?.modelId !== SHELL_MODEL ||
      ready.posture?.providerId !== 'meta' || ready.posture?.sandbox !== 'native_default_no_override' ||
      typeof ready.metadata?.viewCursor !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ready.metadata?.sessionId ?? '') ||
      !Array.isArray(ready.commands) || ready.commands.join(',') !== 'session/start,session/read' ||
      !Array.isArray(ready.providerRequests) || !ready.providerRequests.some(request =>
        request.method === 'GET' && request.path === '/muse-code/models') ||
      ready.providerRequests.some(request => request.path === '/responses')) {
    throw fault('NATIVE_SHELL_READY_INVALID', 'shell host readiness is not an idle isolated native session');
  }
  return ready;
}

export function validateReadFileSchemaOutcome(ready, outcome) {
  const requests = outcome?.providerRequests;
  const responses = requests?.filter(request => request.path === '/responses');
  const main = responses?.filter(request => request.kind === 'native_read_file_schema');
  const reminder = responses?.filter(request => request.kind === 'native_reminder_call');
  if (outcome?.kind !== 'native_read_file_schema_outcome' ||
      outcome.sessionId !== ready.metadata.sessionId || !outcome.turnId ||
      outcome.turnAck?.status !== 'accepted' || outcome.turnAck?.disposition !== 'started' ||
      outcome.turnAck?.startedNewTurn !== true ||
      outcome.event?.kind !== 'turn_completed' || outcome.event.terminal !== 'completed' ||
      outcome.event.turnId !== outcome.turnId || outcome.event.sessionId !== outcome.sessionId ||
      outcome.pending !== null ||
      outcome.commands?.join(',') !== 'session/start,session/read,turn/start' ||
      !Array.isArray(requests) || requests.length > 7 ||
      requests.filter(request => request.method === 'GET' && request.path === '/muse-code/models').length < 1 ||
      requests.filter(request => request.method === 'GET').length > 4 ||
      responses?.length !== 1 + reminder.length || main?.length !== 1 || reminder?.length > 1 ||
      requests.some(request => request.rejection !== undefined || !(
        request.method === 'GET' && request.path === '/muse-code/models' ||
        request.method === 'POST' && request.path === '/responses')) ||
      outcome.observations?.approvals?.length !== 0 || outcome.observations?.items?.length !== 0 ||
      outcome.observations?.protocolErrors?.length !== 0 ||
      outcome.observations?.reminders?.length > reminder.length ||
      outcome.observations?.reminders?.some(item => item.callId !== REMINDER_CALL ||
        item.turnId !== outcome.turnId || item.status !== 'completed') ||
      Object.values(outcome.observations?.omitted ?? {}).some(count => count !== 0) ||
      reminder.some(request => request.model !== SHELL_MODEL ||
        request.responseId !== REMINDER_RESPONSE || request.itemId !== REMINDER_ITEM ||
        request.callId !== REMINDER_CALL || request.payloadSha256 !==
          createHash('sha256').update(JSON.stringify(REMINDER_PAYLOAD)).digest('hex')) ||
      main[0].model !== SHELL_MODEL || main[0].responseId !== 'resp_native_read_file_schema_1' ||
      main[0].mainSchema?.namespace !== 'muse' || main[0].mainSchema.functionCount !== 25 ||
      !Number.isSafeInteger(main[0].mainSchema.readFileCount) ||
      main[0].mainSchema.readFileCount < 0 || main[0].mainSchema.readFileCount > 25 ||
      main[0].mainSchema.omittedFunctions !== 0 ||
      typeof main[0].mainSchema.identityValid !== 'boolean' ||
      (main[0].mainSchema.selected !== null &&
        (main[0].mainSchema.identityValid !== true ||
         main[0].mainSchema.selected.name !== 'read_file' ||
         main[0].mainSchema.selected.index !== 1)) ||
      (main[0].mainSchema.selectedComplete === true &&
        (main[0].mainSchema.identityValid !== true ||
         main[0].mainSchema.readFileCount !== 1 ||
         !main[0].mainSchema.selected ||
         main[0].mainSchema.unsupportedCount !== 0 ||
         main[0].mainSchema.omittedConstraints !== 0 ||
         main[0].mainSchema.selectedTruncated === true)) ||
      main[0].schemaSha256 !== (main[0].mainSchema.selected &&
        createHash('sha256').update(JSON.stringify(main[0].mainSchema.selected)).digest('hex'))) {
    throw fault('NATIVE_READ_FILE_SCHEMA_OUTCOME_INVALID', 'native read_file schema observation was not isolated');
  }
  return { kind: main[0].mainSchema.selectedComplete ? 'native_read_file_schema_observed' :
    'native_read_file_schema_incomplete', schema: main[0].mainSchema };
}

export function validateShellOutcome(ready, outcome) {
  const responses = outcome?.providerRequests?.filter(request => request.path === '/responses') ?? [];
  const reminderCalls = responses.filter(request => request.kind === 'native_reminder_call');
  const shellCalls = responses.filter(request => request.kind === 'native_tool_call');
  const shellResults = responses.filter(request => request.kind === 'matching_tool_result');
  const hasReminder = reminderCalls.length === 1;
  const shell = shellCalls[0];
  const shellResult = shellResults[0];
  if (!['guest_shell_outcome', 'native_shell_approval_pending'].includes(outcome?.kind) ||
      outcome.sessionId !== ready.metadata.sessionId ||
      typeof outcome.turnId !== 'string' || !outcome.turnId ||
      outcome.turnAck?.status !== 'accepted' || outcome.turnAck?.disposition !== 'started' ||
      outcome.turnAck?.startedNewTurn !== true ||
      outcome.commands?.join(',') !== 'session/start,session/read,turn/start' ||
      !Array.isArray(outcome.providerRequests) ||
      reminderCalls.length > 1 || shellCalls.length !== 1 ||
      shellResults.length !== (outcome.kind === 'native_shell_approval_pending' ? 0 : 1) ||
      responses.length !== shellCalls.length + shellResults.length + reminderCalls.length ||
      (shellResult && responses.indexOf(shell) >= responses.indexOf(shellResult)) ||
      outcome.providerRequests.filter(request => request.method === 'GET').length > 4 ||
      outcome.providerRequests.some(request => !(
        request.method === 'GET' && request.path === '/muse-code/models' ||
        request.method === 'POST' && request.path === '/responses') ||
        request.rejection !== undefined) ||
      Object.values(outcome.observations?.omitted ?? {}).some(count => count !== 0) ||
      outcome.observations?.protocolErrors?.length !== 0) {
    throw fault('NATIVE_SHELL_OUTCOME_INVALID', 'native turn or provider sequence was invalid');
  }
  const reminder = reminderCalls[0];
  if (hasReminder && (reminder.model !== SHELL_MODEL || reminder.responseId !== REMINDER_RESPONSE ||
      reminder.itemId !== REMINDER_ITEM || reminder.callId !== REMINDER_CALL ||
      reminder.payloadSha256 !== createHash('sha256').update(JSON.stringify(REMINDER_PAYLOAD)).digest('hex'))) {
    throw fault('NATIVE_SHELL_OUTCOME_INVALID', 'native reminder prelude identity differed');
  }
  if (shell?.kind !== 'native_tool_call' || shell?.model !== SHELL_MODEL ||
      shell?.responseId !== SHELL_RESPONSE || shell?.itemId !== SHELL_ITEM ||
      shell?.callId !== SHELL_CALL || shell?.commandSha256 !== ready.commandSha256 ||
      shell.namespace !== 'muse' || shell.argumentKeys?.join(',') !== 'command,description' ||
      shell.mainSchema?.selectedComplete !== true || shell.mainSchema?.identityValid !== true ||
      JSON.stringify(shell.mainSchema?.selected) !== JSON.stringify(FIXED_BASH_SCHEMA) ||
      shell.schemaSha256 !== createHash('sha256').update(JSON.stringify(FIXED_BASH_SCHEMA)).digest('hex') ||
      shell.afterReminderCallId !== undefined) {
    throw fault('NATIVE_SHELL_OUTCOME_INVALID', 'first native response was not the reviewed tool call');
  }
  const reminders = outcome.observations?.reminders ?? [];
  if (!Array.isArray(reminders) || reminders.length > (hasReminder ? 1 : 0) ||
      reminders.some(item => item.callId !== REMINDER_CALL || item.turnId !== outcome.turnId ||
        item.status !== 'completed')) {
    throw fault('NATIVE_SHELL_OUTCOME_INVALID', 'native reminder observation differed');
  }
  if (outcome.kind === 'native_shell_approval_pending') {
    const approval = outcome.event?.approval;
    if (outcome.event?.kind !== 'approval' || approval?.sessionId !== ready.metadata.sessionId ||
        approval.turnId !== outcome.turnId || approval.toolCallId !== SHELL_CALL ||
        outcome.pending?.approvals?.length !== 1 || outcome.pending.approvals[0].approvalId !== approval.approvalId ||
        outcome.pending.userInputs?.length !== 0 || !approval.choices?.length ||
        approval.commandMatch !== true ||
        JSON.stringify(outcome.pending.approvals[0]) !== JSON.stringify(approval) ||
        outcome.observations.approvals?.length !== 1 ||
        JSON.stringify(outcome.observations.approvals[0]) !== JSON.stringify(approval) ||
        outcome.observations.items?.length !== 0) {
      throw fault('NATIVE_APPROVAL_INVALID', 'unanswered approval was not bound to the native turn');
    }
    return { kind: 'native_shell_approval_pending', approval };
  }
  const tool = outcome.observations?.items;
  if (outcome.event?.kind !== 'turn_completed' || outcome.event.terminal !== 'completed' ||
      outcome.event.turnId !== outcome.turnId || outcome.event.sessionId !== ready.metadata.sessionId ||
      shellResult?.kind !== 'matching_tool_result' ||
      shellResult?.model !== SHELL_MODEL ||
      shellResult?.responseId !== SHELL_TEXT_RESPONSE ||
      shellResult?.forCallId !== SHELL_CALL ||
      shellResult.outputMarkers?.workspaceWritten !== tool?.[0]?.workspaceReportedWritten ||
      shellResult.outputMarkers?.dummyAuthVisible !== tool?.[0]?.dummyAuthVisible ||
      tool?.length !== 1 ||
      tool[0].turnId !== outcome.turnId || tool[0].callId !== SHELL_CALL ||
      tool[0].tool !== 'bash' || tool[0].status !== 'completed' ||
      tool[0].commandMatch !== true || tool[0].outputMarkers !== true ||
      typeof tool[0].workspaceReportedWritten !== 'boolean' ||
      typeof tool[0].dummyAuthVisible !== 'boolean') {
    throw fault('NATIVE_SHELL_OUTCOME_INVALID', 'native tool result or turn completion was not correlated');
  }
  return { kind: tool[0].workspaceReportedWritten ? 'native_shell_effect_observed' :
    'native_shell_denial_observed', turnId: outcome.turnId,
    toolItemId: tool[0].itemId, dummyAuthVisible: tool[0].dummyAuthVisible };
}

export function validateHeldHandoff(ready, handoff, command, workspace, protectedRoot, token) {
  if (handoff?.kind !== 'native_shell_live_approval' ||
      !/^[0-9a-f]{32}$/.test(handoff.handoffId ?? '') || handoff.command !== command ||
      handoff.waitBudgetMs !== HELD_INPUT_MS ||
      !Number.isFinite(Date.parse(handoff.expiresAt)) ||
      Date.parse(handoff.expiresAt) <= Date.now() ||
      Date.parse(handoff.expiresAt) > Date.now() + HELD_INPUT_MS ||
      handoff.approval?.sessionId !== ready.metadata.sessionId ||
      handoff.approval.toolCallId !== SHELL_CALL || handoff.approval.toolName !== 'bash' ||
      handoff.approval.commandMatch !== true ||
      !Number.isSafeInteger(handoff.approval.requirementId?.sourceIndex) ||
      handoff.approval.requirementId.approvalId !== handoff.approval.approvalId ||
      handoff.effects?.workspaceWrite !== join(workspace, 'shell-canary') ||
      handoff.effects.protectedDirect !== join(protectedRoot, token) ||
      handoff.effects.protectedSymlink !== join(workspace, 'protected-link', token) ||
      handoff.effects.protectedProc !== `/proc/1/root${join(protectedRoot, token)}` ||
      handoff.effects.dummyAuth !== `${GUEST_HOME}/.config/muse/auth.json` ||
      !Array.isArray(handoff.approval.choices) || handoff.approval.choices.length < 1 ||
      handoff.approval.choices.length > 16 ||
      handoff.approval.choices.some(choice => typeof choice.choiceId !== 'string' ||
        typeof choice.decision !== 'string' || typeof choice.label !== 'string' ||
        typeof choice.scope !== 'string')) {
    throw fault('NATIVE_HELD_HANDOFF_INVALID', 'held host presentation differed from fresh shell fixture');
  }
  return handoff;
}

export function validateHeldShellOutcome(ready, outcome) {
  const held = outcome?.held;
  if (outcome?.kind !== 'native_shell_held_decided' || held?.kind !== 'decided' ||
      held.presentation?.approval?.sessionId !== ready.metadata.sessionId ||
      held.presentation.approval.approvalId !== outcome.event?.approval?.approvalId ||
      outcome.pending?.approvals?.length !== 1 ||
      JSON.stringify(outcome.pending.approvals[0]) !== JSON.stringify(held.presentation.approval) ||
      held.decision?.ack?.status !== 'accepted' || held.decision.ack.terminal !== true ||
      held.decision.ack.commandId !== held.decision.commandId ||
      held.resolved?.kind !== 'approval/resolved' ||
      held.resolved.approvalId !== held.presentation.approval.approvalId ||
      held.resolved.sessionId !== outcome.sessionId || held.resolved.turnId !== outcome.turnId ||
      held.resolved.decidedByCommandId !== held.decision.commandId ||
      held.resolved.resolvedBy !== 'user' ||
      held.resolved.decision !== held.decision.choice?.decision ||
      held.item?.callId !== SHELL_CALL || held.item.turnId !== outcome.turnId ||
      held.terminal?.turnId !== outcome.turnId || held.terminal.sessionId !== outcome.sessionId ||
      outcome.observations?.approvals?.length !== 1 ||
      JSON.stringify(outcome.observations.approvals[0]) !== JSON.stringify(held.presentation.approval)) {
    throw fault('NATIVE_HELD_OUTCOME_INVALID', 'held decision lacked correlated resolution, tool and turn');
  }
  validateHeldDecision(held.presentation, { kind: 'choice', handoffId: held.presentation.handoffId,
    sessionId: outcome.sessionId, turnId: outcome.turnId, callId: SHELL_CALL,
    approvalId: held.presentation.approval.approvalId,
    requirementId: held.presentation.approval.requirementId,
    choiceId: held.decision.choice.choiceId }, false);
  if (outcome.observations.items?.length !== 1 ||
      JSON.stringify(held.item) !== JSON.stringify(outcome.observations.items[0])) {
    throw fault('NATIVE_HELD_OUTCOME_INVALID', 'held tool item differs from observed item');
  }
  if (held.decision.choice.decision === 'approved') {
    return validateShellOutcome(ready, { ...outcome, kind: 'guest_shell_outcome',
      event: { kind: 'turn_completed', terminal: held.terminal.terminal,
        turnId: held.terminal.turnId, sessionId: held.terminal.sessionId }, pending: null });
  }
  if (held.decision.choice.decision === 'abort' && held.terminal.terminal === 'cancelled' &&
      held.item.status === 'completed' && held.item.commandMatch === true &&
      held.item.tool === 'bash' && held.item.abortDenial === true &&
      held.item.outputMarkers === false && held.item.workspaceReportedWritten === null &&
      held.item.dummyAuthVisible === null && held.item.outputShape?.type === 'string' &&
      held.item.outputShape.bytes === Buffer.byteLength('tool denied: approval aborted') &&
      outcome.providerRequests.filter(request => request.kind === 'matching_tool_result').length === 0 &&
      outcome.observations.items[0].callId === SHELL_CALL) {
    validateShellOutcome(ready, { ...outcome, kind: 'native_shell_approval_pending',
      observations: { ...outcome.observations, items: [] } });
    return { kind: 'native_shell_held_rejected', turnId: outcome.turnId,
      approvalId: held.presentation.approval.approvalId };
  }
  throw fault('NATIVE_HELD_OUTCOME_INVALID', 'held choice outcome is outside reviewed native behavior');
}

async function shellEffects(workspace, protectedRoot, token) {
  let shell = null;
  try { shell = await readFile(join(workspace, 'shell-canary'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const protectedBytes = await readFile(join(protectedRoot, token), 'utf8');
  const protectedNames = await readdir(protectedRoot);
  const link = await lstat(join(workspace, 'protected-link'));
  return { shellWritten: shell === 'native-write', shellAbsent: shell === null,
    protectedIntact: protectedBytes === 'host-only' && protectedNames.length === 1 &&
      protectedNames[0] === token && link.isSymbolicLink() };
}

export function classifyDurableApprovalLog(bytes, { sessionId, turnId, approvalId,
  callId = SHELL_CALL, command, workspace }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > APPROVAL_LOG_LIMIT) {
    throw fault('NATIVE_APPROVAL_LOG_BOUNDS', 'durable approval log was empty or exceeded the read bound');
  }
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) !== '' || lines.length > 1025) {
    throw fault('NATIVE_APPROVAL_LOG_BOUNDS', 'durable approval log had an incomplete or excessive line set');
  }
  lines.pop();
  const entries = [];
  const frameKeys = ['children', 'content_sha256', 'frame_schema_version',
    'outer_log_ordinal', 'retained_frame', 'transaction_id'];
  const childTypes = ['runtime.session.permission_format_declared',
    'runtime.session.permission_profile_committed'];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); }
    catch { throw fault('NATIVE_APPROVAL_LOG_INVALID', 'durable approval log contained malformed JSON'); }
    if (entry?.retained_frame !== undefined) {
      if (entries.length || entry.retained_frame !== 'session_permission_transaction' ||
          entry.frame_schema_version !== 1 || entry.outer_log_ordinal !== 1 ||
          Object.keys(entry).sort().join(',') !== frameKeys.sort().join(',') ||
          !/^[0-9a-f-]{36}$/i.test(entry.transaction_id ?? '') ||
          !/^sha256:[0-9a-f]{64}$/.test(entry.content_sha256 ?? '') ||
          !Array.isArray(entry.children) || entry.children.length !== 2) {
        throw fault('NATIVE_APPROVAL_LOG_FRAME_INVALID', 'durable permission frame differed');
      }
      for (let index = 0; index < 2; index++) {
        const child = entry.children[index];
        if (child?.child_index !== index ||
            Object.keys(child).sort().join(',') !== 'child_index,record_json' ||
            typeof child.record_json !== 'string') {
          throw fault('NATIVE_APPROVAL_LOG_FRAME_INVALID', 'durable permission child differed');
        }
        let decoded;
        try { decoded = JSON.parse(child.record_json); }
        catch { throw fault('NATIVE_APPROVAL_LOG_FRAME_INVALID', 'durable permission child was malformed'); }
        if (decoded?.payload_type !== childTypes[index] || decoded.payload_schema_version !== 1 ||
            decoded.payload?.schema_version !== 1 || decoded.payload?.run_id !== undefined ||
            decoded.payload?.event !== undefined || decoded.payload?.record !== undefined ||
            decoded.payload?.kind !== undefined ||
            (index === 0 && (Object.keys(decoded.payload).sort().join(',') !== 'format,schema_version' ||
              decoded.payload.format !== 'profile_v1')) ||
            (index === 1 && Object.keys(decoded.payload).sort().join(',') !==
              'actor,cause,command,definition_sha256,managed_ancestor_sha256,managed_enforcement,pending_action_cancellations,permission_epoch,resolved_snapshot,resulting_snapshot_sha256,schema_version,source')) {
          throw fault('NATIVE_APPROVAL_LOG_FRAME_INVALID', 'durable permission child content differed');
        }
        entries.push(decoded);
      }
    } else entries.push(entry);
  }
  if (entries.length > 1024) {
    throw fault('NATIVE_APPROVAL_LOG_BOUNDS', 'durable approval log had too many decoded records');
  }
  const seen = new Map();
  let lastSequence = 0;
  for (const entry of entries) {
    if (seen.has('session_end')) {
      throw fault('NATIVE_APPROVAL_LOG_AMBIGUOUS', 'durable session log continued after clean end');
    }
    if (entry?.schema_version !== 1 || entry.record_type !== 'event' ||
        entry.durability !== 'durable' ||
        !Number.isSafeInteger(entry?.sequence) || entry.sequence <= lastSequence ||
        entry.stream?.kind !== 'session' || entry.stream.id !== sessionId) {
      throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable approval log envelope or session differed');
    }
    lastSequence = entry.sequence;
    const payload = entry.payload;
    if (entry.payload_type === 'session.end') {
      if (entry.payload_schema_version !== 1 || payload?.kind !== 'session_end' ||
          payload.event !== undefined ||
          payload?.record?.schema_version !== 1 || payload.record.session_id !== sessionId ||
          payload.record.exit_reason !== 'clean' || seen.has('session_end')) {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable session end identity differed');
      }
      seen.set('session_end', entry.sequence);
      continue;
    }
    const record = payload?.record ?? payload?.event;
    if (seen.has('run_terminal') && payload?.run_id === turnId) {
      throw fault('NATIVE_APPROVAL_LOG_AMBIGUOUS', 'durable run continued after cancelled terminal');
    }
    if (payload?.run_id !== turnId) {
      if (['approval', 'approval_wait_effect'].includes(payload?.kind) &&
          (record?.pending_action_id === approvalId || record?.tool_call_id === callId)) {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable approval belonged to another run');
      }
      continue;
    }
    if ((payload?.kind === 'approval' &&
         !['requested', 'decision_applied'].includes(record?.kind)) ||
        (payload?.kind === 'approval_wait_effect' &&
         !['started', 'terminal'].includes(record?.kind))) {
      throw fault('NATIVE_APPROVAL_LOG_TERMINAL_UNKNOWN', 'durable approval contained an unreviewed event');
    }
    let key;
    if (payload.kind === 'approval' && record?.kind === 'requested') {
      key = 'requested';
      if (entry.payload_type !== 'runtime.session' || entry.payload_schema_version !== 3 ||
          payload.record !== undefined || payload.event !== record ||
          record.pending_action_id !== approvalId || record.tool_call_id !== callId ||
          record.tool_name !== 'bash' || record.run_stream?.kind !== 'run' ||
          record.run_stream.id !== turnId || record.session_stream?.kind !== 'session' ||
          record.session_stream.id !== sessionId ||
          record.approval_subject?.kind !== 'shell_command' ||
          record.approval_subject?.raw_command !== command ||
          record.approval_subject?.canonical_workspace_root !== workspace) {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable approval request differed');
      }
    } else if (payload.kind === 'approval_wait_effect' && record?.kind === 'started') {
      key = 'wait_started';
      if (entry.payload_type !== 'approval_wait.effect.started' || entry.payload_schema_version !== 1 ||
          payload.event !== undefined || payload.record !== record ||
          record.pending_action_id !== approvalId || record.tool_call_id !== callId ||
          record.tool_name !== 'bash' || record.run_stream?.kind !== 'run' ||
          record.run_stream.id !== turnId) {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable approval wait differed');
      }
    } else if (payload.kind === 'approval' && record?.kind === 'decision_applied') {
      key = 'decision';
      if (entry.payload_type !== 'runtime.session' || entry.payload_schema_version !== 3 ||
          payload.record !== undefined || payload.event !== record ||
          record.pending_action_id !== approvalId || record.decision !== 'abort' ||
          record.session_stream?.kind !== 'session' || record.session_stream.id !== sessionId) {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable approval decision differed');
      }
    } else if (payload.kind === 'approval_wait_effect' && record?.kind === 'terminal') {
      key = 'wait_terminal';
      if (entry.payload_type !== 'approval_wait.effect.terminal' || entry.payload_schema_version !== 1 ||
          payload.event !== undefined || payload.record !== record ||
          record.pending_action_id !== approvalId || record.outcome?.kind !== 'aborted') {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable approval wait terminal differed');
      }
    } else if (payload.kind === 'run' && record?.kind === 'tool_result_batch_committed') {
      key = 'tool_result';
      if (entry.payload_type !== 'runtime.session' || entry.payload_schema_version !== 1 ||
          payload.record !== undefined || payload.event !== record ||
          record.results?.length !== 1 || record.results[0]?.tool_call_id !== callId ||
          record.results[0]?.text !== 'tool denied: approval aborted') {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable tool result differed');
      }
    } else if (payload.kind === 'run' && record?.kind === 'terminal') {
      key = 'run_terminal';
      if (entry.payload_type !== 'runtime.session' || entry.payload_schema_version !== 1 ||
          payload.record !== undefined || payload.event !== record ||
          record.terminal !== 'cancelled') {
        throw fault('NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH', 'durable run terminal differed');
      }
    }
    if (key) {
      if (seen.has(key)) throw fault('NATIVE_APPROVAL_LOG_AMBIGUOUS', 'durable approval event was duplicated');
      seen.set(key, entry.sequence);
    }
  }
  const ordered = ['requested', 'wait_started', 'decision', 'wait_terminal',
    'tool_result', 'run_terminal', 'session_end'];
  if (ordered.some(key => !seen.has(key)) ||
      ordered.some((key, index) => index > 0 && seen.get(key) <= seen.get(ordered[index - 1]))) {
    throw fault('NATIVE_APPROVAL_LOG_TERMINAL_UNKNOWN', 'durable approval terminal chain was incomplete');
  }
  return { kind: 'native_shell_approval_aborted_on_shutdown', sessionId, turnId,
    approvalId, callId, sequences: Object.fromEntries(ordered.map(key => [key, seen.get(key)])) };
}

export async function readDurableApprovalLog(root, guestPath, identity) {
  const prefix = `${GUEST_HOME}/.local/share/muse/sessions/`;
  const suffix = typeof guestPath === 'string' && guestPath.startsWith(prefix) ? guestPath.slice(prefix.length) : '';
  if (!/^\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\/session\.jsonl$/i.test(suffix) ||
      suffix.split('/')[3] !== identity.sessionId) {
    throw fault('NATIVE_APPROVAL_LOG_PATH_INVALID', 'durable approval log path is outside the owned session');
  }
  const home = join(root, 'home');
  const parts = ['.local', 'share', 'muse', 'sessions', ...suffix.split('/')];
  let path = home;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) path = join(path, parts[index]);
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (error.code === 'ENOENT') throw fault('NATIVE_APPROVAL_LOG_ABSENT', 'durable approval log is absent');
      throw error;
    }
    if (stat.uid !== process.getuid() || stat.isSymbolicLink() ||
        (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw fault('NATIVE_APPROVAL_LOG_PATH_INVALID', 'durable approval log path is not owned regular storage');
    }
    if (index === parts.length - 1 && (stat.size === 0 || stat.size > APPROVAL_LOG_LIMIT)) {
      throw fault('NATIVE_APPROVAL_LOG_BOUNDS', 'durable approval log exceeded the read bound');
    }
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > APPROVAL_LOG_LIMIT) {
      throw fault('NATIVE_APPROVAL_LOG_PATH_INVALID', 'durable approval log changed before read');
    }
    const buffer = Buffer.alloc(APPROVAL_LOG_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return classifyDurableApprovalLog(buffer.subarray(0, length), identity);
  } finally { await file.close(); }
}

export async function qualifyNativeShell({ muse = '/home/jeremy/.local/bin/muse',
  checkBubblewrap = probeBubblewrap, stage = stageRuntime, startSentinel = startHostSentinel,
  probe = tcpProbe, launch = runStatusPhase, capture = captureHostIdentities,
  stop = verifyHostStop, held = false, readFileSchemaOnly = false, requestDecision } = {}) {
  const root = await mkdtemp(join(tmpdir(), readFileSchemaOnly ?
    'passeur-muse-read-file-schema-' : 'passeur-muse-native-shell-sandbox-'));
  let sentinel;
  let host;
  let captured;
  let stopAttempted = false;
  let stageName = 'stage';
  let outcome;
  let primaryGuestFailure;
  const evidence = {};
  try {
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const token = 'protected-canary';
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(protectedRoot)]);
    await writeFile(join(protectedRoot, token), 'host-only');
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(root, muse);
    sentinel = await startSentinel();
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable before shell host');
    }
    const prepared = prepareSandbox(sandboxConfig({ workspace, runtime, home, protectedRoot }), guestCommand());
    checkBubblewrap();
    stageName = 'shell_host';
    host = launch(prepared, { phase: held ? 'held-shell' : readFileSchemaOnly ? 'read-file-schema' : 'shell',
      workspace, hostPort: sentinel.port,
      protectedRoot, canaryToken: token });
    const [ready, liveStatus] = await Promise.all([host.ready, host.liveStatus]);
    evidence.ready = ready;
    evidence.liveStatus = liveStatus;
    validateShellReady(ready, workspace, sentinel.port);
    if (ready.commandSha256 !== createHash('sha256').update(shellProbeCommand(workspace, protectedRoot, token)).digest('hex')) {
      throw fault('NATIVE_SHELL_READY_INVALID', 'guest shell command differs from host fixture command');
    }
    if (!liveStatus.child || liveStatus.exit !== null) throw fault('BWRAP_STATUS_INVALID', 'live shell status missing child');
    captured = await capture(host.pid, liveStatus.child, ready.nativeIdentity.start,
      `${GUEST_RUNTIME}/muse-bin-${VERSION}`, `${GUEST_RUNTIME}/node`);
    evidence.capture = { boot: captured.boot, pidns: captured.pidns, wrapper: captured.wrapper,
      statusChild: captured.statusChild, init: captured.init, supervisor: captured.supervisor,
      native: captured.native, memberCount: captured.members?.length };
    if (captured.native.nspid.at(-1) !== ready.nativeIdentity.pid ||
        captured.native.netns !== ready.nativeNamespace ||
        captured.supervisor.netns !== ready.guestNamespace) {
      throw fault('STOP_ASSOCIATION_INVALID', 'native shell host marker differs from observed process tree');
    }
    stageName = 'native_turn';
    host.releaseTurn();
    let handoffInputError;
    let chosenInput;
    if (held) {
      stageName = 'held_approval';
      const handoff = await host.handoff;
      if (handoff?.kind === 'guest_transport_error') {
        primaryGuestFailure = { stage: handoff.stage, code: handoff.code, message: handoff.message };
        evidence.primaryGuestFailure = primaryGuestFailure;
        evidence.earlyGuestFailure = handoff;
      } else {
        validateHeldHandoff(ready, handoff, shellProbeCommand(workspace, protectedRoot, token),
          workspace, protectedRoot, token);
        evidence.liveHandoff = handoff;
        let input;
        try {
          if (typeof requestDecision !== 'function') {
            throw fault('NATIVE_HELD_INPUT_UNAVAILABLE', 'no host-controlled human input reader was supplied');
          }
          input = await timeout('human held decision', requestDecision(handoff), HELD_WAIT_MS);
          if (input != null) {
            validateHeldDecision(handoff, input);
            chosenInput = input;
          }
        } catch (error) {
          handoffInputError = error;
          evidence.humanInputError = { code: error.code ?? error.name,
            message: String(error.message).slice(0, 300) };
        }
        host.sendDecision(handoffInputError || input == null ? { kind: 'expire' } : input);
      }
    }
    let guestOutcome;
    let outcomeError;
    try { guestOutcome = await host.outcome; evidence.guestOutcome = guestOutcome; }
    catch (error) { outcomeError = error; evidence.outcomeError = { code: error.code ?? error.name,
      message: String(error.message).slice(0, 300) }; }
    primaryGuestFailure ??= guestOutcome?.kind === 'guest_transport_error' ?
      { stage: guestOutcome.stage, code: guestOutcome.code, message: guestOutcome.message } : null;
    if (primaryGuestFailure) evidence.primaryGuestFailure = primaryGuestFailure;
    host.releaseShutdown();
    const done = await timeout('shell host exit', host.finished,
      (held ? HELD_DEADLINE_MS : DEADLINE_MS) + 3_000);
    evidence.completion = { code: done.code, signal: done.signal, timedOut: done.timedOut,
      overflow: done.overflow, statusClosed: done.statusClosed, statusLines: done.statusLines,
      output: done.output, stderr: done.stderr };
    const expectedOutput = held && !evidence.earlyGuestFailure ? 4 : 3;
    if (done.output.length === expectedOutput) {
      try {
        const finalLine = JSON.parse(done.output[expectedOutput - 1]);
        if (finalLine?.kind === 'guest_transport_error') {
          const finalFailure = decodeShellOutcomeLine(done.output[expectedOutput - 1]);
          evidence.terminalGuestFailure = { stage: finalFailure.stage, code: finalFailure.code,
            message: finalFailure.message, providerRequests: finalFailure.providerRequests };
          primaryGuestFailure ??= { stage: finalFailure.stage, code: finalFailure.code,
            message: finalFailure.message };
          evidence.primaryGuestFailure ??= primaryGuestFailure;
        }
      } catch (error) {
        evidence.terminalGuestError = { code: error.code ?? error.name,
          message: String(error.message).slice(0, 300) };
      }
    }
    let terminal;
    try { terminal = parseBubblewrapStatus(done.statusLines); }
    catch (error) { evidence.terminalError = { code: error.code ?? error.name,
      message: String(error.message).slice(0, 300) };
      if (primaryGuestFailure) throw fault(primaryGuestFailure.code, primaryGuestFailure.message);
      throw error; }
    evidence.terminal = terminal;
    stopAttempted = true;
    let stopped;
    try { stopped = await timeout('shell host stop scan', stop(captured, terminal, done));
      evidence.stop = stopped; }
    catch (error) { evidence.stopError = { code: error.code ?? error.name,
      message: String(error.message).slice(0, 300) };
      if (primaryGuestFailure) throw fault(primaryGuestFailure.code, primaryGuestFailure.message);
      throw error; }
    await captured.fd.close(); captured = undefined;
    if (primaryGuestFailure) throw fault(primaryGuestFailure.code, primaryGuestFailure.message);
    if (stopped.kind !== 'confirmed') throw fault('STOP_UNCONFIRMED', 'shell namespace stop was not confirmed');
    if (handoffInputError) throw handoffInputError;
    if (outcomeError) throw outcomeError;
    if (done.code !== 0 || done.output.length !== expectedOutput || done.timedOut || done.overflow ||
        JSON.stringify(JSON.parse(done.output[expectedOutput - 1])) !== JSON.stringify(guestOutcome)) {
      throw fault('GUEST_OUTPUT_INVALID', 'shell terminal output differed from held outcome');
    }
    if (held && guestOutcome?.held?.presentation &&
        JSON.stringify(guestOutcome.held.presentation) !== JSON.stringify(evidence.liveHandoff)) {
      throw fault('NATIVE_HELD_HANDOFF_INVALID', 'terminal held presentation differed from live handoff');
    }
    if (held && ((guestOutcome.kind === 'native_shell_held_decided') !== Boolean(chosenInput) ||
        (chosenInput && guestOutcome.held?.decision?.choice?.choiceId !== chosenInput.choiceId))) {
      throw fault('NATIVE_HELD_OUTCOME_INVALID', 'terminal held decision differed from host-supplied choice');
    }
    const classified = readFileSchemaOnly ? validateReadFileSchemaOutcome(ready, guestOutcome) :
      held && guestOutcome.kind === 'native_shell_held_decided' ?
        validateHeldShellOutcome(ready, guestOutcome) : validateShellOutcome(ready, guestOutcome);
    const effects = await shellEffects(workspace, protectedRoot, token);
    if (!effects.protectedIntact || classified.kind === 'native_shell_effect_observed' && !effects.shellWritten ||
        classified.kind === 'native_shell_denial_observed' && !effects.shellAbsent ||
        (readFileSchemaOnly || ['native_shell_approval_pending', 'native_shell_held_rejected'].includes(classified.kind)) &&
          !effects.shellAbsent) {
      throw fault('NATIVE_SHELL_EFFECT_INVALID', 'workspace or protected canary contradicted native outcome');
    }
    if (classified.dummyAuthVisible === true) {
      throw fault('NATIVE_SHELL_AUTH_VISIBLE', 'native shell could read the disposable dummy auth file');
    }
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable after shell host');
    }
    let finalKind = classified.kind;
    if (classified.kind === 'native_shell_approval_pending') {
      try {
        evidence.approvalTerminal = await readDurableApprovalLog(root, ready.metadata.durableLogPath, {
          sessionId: ready.metadata.sessionId, turnId: guestOutcome.turnId,
          approvalId: classified.approval.approvalId, callId: SHELL_CALL,
          command: shellProbeCommand(workspace, protectedRoot, token), workspace,
        });
        finalKind = evidence.approvalTerminal.kind;
      } catch (error) {
        evidence.approvalTerminalError = { code: error.code ?? error.name,
          message: String(error.message).slice(0, 300) };
        finalKind = 'native_shell_approval_terminal_unknown';
      }
    }
    outcome = { kind: finalKind, classified, effects, evidence };
  } catch (error) {
    if (primaryGuestFailure && error.code !== primaryGuestFailure.code) {
      evidence.secondaryError = { code: error.code ?? error.name,
        message: String(error.message).slice(0, 300) };
    }
    outcome = { kind: 'native_shell_error', stage: primaryGuestFailure?.stage ?? stageName,
      code: primaryGuestFailure?.code ?? error.code ?? error.name,
      message: (primaryGuestFailure?.message ?? String(error.message)).slice(0, 400),
      stopProof: evidence.stop?.kind ?? 'unconfirmed', evidence };
  } finally {
    if (host) {
      host.abort();
      try {
        const done = await timeout('shell shutdown', host.finished,
          (held ? HELD_DEADLINE_MS : DEADLINE_MS) + 3_000);
        evidence.completion ??= { code: done.code, signal: done.signal, timedOut: done.timedOut,
          overflow: done.overflow, statusClosed: done.statusClosed, statusLines: done.statusLines,
          output: done.output, stderr: done.stderr };
        if (captured && !stopAttempted) {
          try {
            const terminal = parseBubblewrapStatus(done.statusLines);
            evidence.terminal ??= terminal;
            stopAttempted = true;
            evidence.stop = await timeout('shell final stop scan', stop(captured, terminal, done));
          } catch (error) { evidence.stopError = { code: error.code ?? error.name,
            message: String(error.message).slice(0, 300) }; }
        }
      } catch { /* retained root and unconfirmed stop */ }
    }
    if (captured) try { await captured.fd.close(); } catch { /* retained root */ }
    if (sentinel) try { await sentinel.close(); } catch { /* retained root */ }
  }
  outcome.retainedFixtures = [root];
  return outcome;
}

export async function qualifyNativeShellHeld(options = {}) {
  return qualifyNativeShell({ ...options, held: true });
}

export async function qualifyNativeReadFileSchema(options = {}) {
  return qualifyNativeShell({ ...options, readFileSchemaOnly: true });
}

export function diagnosticMode(args) {
  if (args.length === 0) return 'idle-resume';
  if (args.length === 1 && args[0] === '--native-shell') return 'native-shell';
  if (args.length === 1 && args[0] === '--native-shell-held') return 'native-shell-held';
  if (args.length === 1 && args[0] === '--native-read-file-schema') return 'native-read-file-schema';
  throw fault('DIAGNOSTIC_MODE_INVALID', 'use no arguments, --native-shell, --native-shell-held, or --native-read-file-schema');
}

export async function readHeldCliDecision(handoff, input = process.stdin, output = process.stdout) {
  output.write(`${JSON.stringify({ kind: 'native_shell_live_handoff', result: handoff })}\n`);
  const lines = createInterface({ input });
  let timer;
  try {
    const next = await Promise.race([lines[Symbol.asyncIterator]().next(),
      new Promise(resolveResult => { timer = setTimeout(() => resolveResult({ done: true }), HELD_INPUT_MS); })]);
    if (next.done) return null;
    if (Buffer.byteLength(next.value) > LIMIT) {
      throw fault('NATIVE_HELD_INPUT_INVALID', 'human choice line exceeded bound');
    }
    let parsed;
    try { parsed = JSON.parse(next.value); }
    catch { throw fault('NATIVE_HELD_INPUT_INVALID', 'human choice line was not JSON'); }
    return parsed;
  } finally { clearTimeout(timer); lines.close(); }
}

export async function qualify({ muse = '/home/jeremy/.local/bin/muse',
  checkBubblewrap = probeBubblewrap, run = runCaptured, stage = stageRuntime,
  startSentinel = startHostSentinel, probe = tcpProbe } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-sandbox-transport-'));
  let sentinel;
  let hostStarted = false;
  let stageName = 'stage';
  let outcome;
  try {
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const token = 'protected-canary';
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(protectedRoot)]);
    await writeFile(join(protectedRoot, token), 'host-only');
    // The symlink route must resolve to a host path that is absent in the guest.
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(root, muse);
    stageName = 'host_sentinel';
    sentinel = await startSentinel();
    const before = await probe('127.0.0.1', sentinel.port);
    if (before.kind !== 'connected') throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel was not reachable before guest');
    stageName = 'sandbox_prepare';
    const config = sandboxConfig({ workspace, runtime, home, protectedRoot });
    const prepared = prepareSandbox(config, guestCommand());
    checkBubblewrap();
    stageName = 'guest';
    hostStarted = true;
    const executed = await run(prepared.executable, prepared.args, {
      input: JSON.stringify({ workspace, hostPort: sentinel.port, protectedRoot, canaryToken: token }),
    });
    const after = await probe('127.0.0.1', sentinel.port);
    if (after.kind !== 'connected') throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel was not reachable after guest');
    const processExit = { code: executed.code, signal: executed.signal ?? null,
      timedOut: executed.timedOut === true, overflow: executed.overflow === true };
    if (processExit.timedOut || processExit.overflow) {
      throw Object.assign(fault('GUEST_PROCESS_FAILED', 'guest process exceeded its deadline or output limit'), { processExit });
    }
    let guest;
    try { guest = JSON.parse(executed.output); }
    catch { throw Object.assign(fault(executed.code === 0 ? 'GUEST_OUTPUT_INVALID' : 'GUEST_PROCESS_FAILED',
      'guest output was not one bounded JSON object'), { processExit }); }
    if (guest?.kind === 'guest_transport_error') {
      throw Object.assign(fault(guest.code ?? 'GUEST_TRANSPORT_FAILED', guest.message ?? 'guest transport failed'),
        { processExit, guestFailure: { stage: guest.stage ?? null, code: guest.code ?? null,
          guestNamespace: guest.guestNamespace ?? null, guestPort: guest.guestPort ?? null,
          commands: guest.commands ?? [], providerRequests: guest.providerRequests ?? [] } });
    }
    if (guest?.kind !== 'guest_transport_observed' || executed.code !== 0) {
      throw Object.assign(fault('GUEST_PROCESS_FAILED', 'guest result and process exit disagreed'), { processExit });
    }
    const hostNamespace = await readlink('/proc/self/ns/net');
    if (hostNamespace === guest.guestNamespace || guest.nativeNamespace !== guest.guestNamespace) {
      throw fault('NETWORK_NAMESPACE_INVALID', 'host, guest and native network namespace identities disagree');
    }
    outcome = { kind: 'transport_observed', hostNamespace, hostSentinel: { port: sentinel.port,
      before: before.kind, after: after.kind }, guest, stopProof: 'descendants_unverified' };
  } catch (error) {
    outcome = { kind: 'transport_error', stage: stageName, code: error.code ?? error.name,
      message: String(error.message).slice(0, 500),
      ...(error.processExit ? { processExit: error.processExit } : {}),
      ...(error.guestFailure ? { guestFailure: error.guestFailure } : {}),
      stopProof: 'descendants_unverified' };
  } finally {
    if (sentinel) try { await sentinel.close(); } catch { /* retained root */ }
  }
  // Every host-started fixture is deliberately retained: SDK close and wrapper
  // exit do not prove the absence of escaped descendants.
  outcome.retainedFixtures = [root];
  outcome.hostStarted = hostStarted;
  return outcome;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--guest') {
    try {
      const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
      const first = await lines.next();
      if (first.done || Buffer.byteLength(first.value) > LIMIT) throw fault('GUEST_INPUT_TOO_LARGE', 'guest input missing or exceeds limit');
      const config = JSON.parse(first.value);
      config.release = async () => (await lines.next()).value;
      const result = ['shell', 'held-shell', 'read-file-schema'].includes(config.phase) ?
        await guestShellRun(config) : await guestRun(config);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = ['guest_transport_observed', 'guest_resume_observed',
        'guest_shell_outcome', 'native_shell_approval_pending',
        'native_shell_held_decided', 'native_read_file_schema_outcome'].includes(result.kind) ? 0 : 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_transport_error', code: error.code ?? error.name,
        message: String(error.message).slice(0, 500) })}\n`);
      process.exitCode = 1;
    }
  } else {
    try {
      const mode = diagnosticMode(process.argv.slice(2));
      const result = mode === 'native-shell-held' ? await qualifyNativeShellHeld({
        requestDecision: handoff => readHeldCliDecision(handoff),
      }) : mode === 'native-shell' ? await qualifyNativeShell() :
        mode === 'native-read-file-schema' ? await qualifyNativeReadFileSchema() :
          await qualifyFreshHostResume();
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ kind: 'diagnostic_error', code: error.code ?? error.name,
        message: String(error.message).slice(0, 200) })}\n`);
      process.exitCode = 2;
    }
  }
}
