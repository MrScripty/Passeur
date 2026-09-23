import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, B, request, command, key } from '../fixtures/structural/service-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

test('authenticated TSX report and detail preserve UTF-8 source ranges for a JSX-only edit', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const reader = { owner_id: B.owner_id, client_id: randomUUID() };
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version,
    node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const runtime = new RepositoryRuntime(intent, identity); f.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate(request('initialize', { limits: f.limits }), owner, f.root);

  const prefix = '// β😀\n';
  const before = `${prefix}export function Panel({title}: {title: string}): JSX.Element { return <h1>{title}</h1>; }\n`;
  const after = `${prefix}export function Panel({title}: {title: string}): JSX.Element { return <h2>{title}</h2>; }\n`;
  const inputOid = await f.commit(f.root, 'Panel.tsx', before);
  await writeFile(join(f.root, 'Panel.tsx'), after);
  const receipt = await runtime.coordinate(f.registerRequest({ input_oid: inputOid,
    areas: [{ kind: 'file', path: 'Panel.tsx' }], readers: [reader.owner_id] }), owner, f.root);
  const workId = receipt.receipt.item_id;
  const response = await runtime.structuralReport(workId, owner, f.root);
  assert.deepEqual(response.reports.map(row => [row.path, row.dialect]), [['Panel.tsx', 'tsx']]);
  const row = response.reports[0];
  assert.match(row.text, /declaration_unchanged/);
  assert.match(row.text, /body_changed \(body omitted\)/);
  assert.match(row.text, /OBSERVED: "export function Panel\(\{title\}: \{title: string\}\): JSX.Element"/);
  const start = Buffer.byteLength(prefix);
  const end = Buffer.byteLength(after.trimEnd());
  assert.ok(row.text.includes(`source bytes: ${start}..${end}`));
  await writeFile(join(f.root, 'Panel.tsx'), `${prefix}export function replaced() {}\n`);
  const detail = await runtime.structuralDetail(workId, row.report_id, 'observed', start, end, owner);
  assert.equal(detail.text, after.slice(prefix.length).trimEnd());
  await assert.rejects(runtime.structuralDetail(workId, row.report_id, 'observed', start, end, reader),
    { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
});

test('authenticated declared files route JS, React and Svelte component/script suffixes', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version,
    node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const runtime = new RepositoryRuntime(intent, identity); f.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate(request('initialize', { limits: f.limits }), owner, f.root);
  await mkdir(join(f.root, 'src'));
  const paths = new Map([
    ['src/alpha.js', ['function alpha() { return <p/>; }\n', 'function alpha() { return <span/>; }\n', 'javascript']],
    ['src/beta.mjs', ['export function beta() { return 1; }\n', 'export function beta() { return 2; }\n', 'javascript']],
    ['src/gamma.cjs', ['module.exports.gamma = function() { return 1; };\n', 'module.exports.gamma = function() { return 2; };\n', 'javascript']],
    ['src/delta.jsx', ['export function Delta() { return <p/>; }\n', 'export function Delta() { return <span/>; }\n', 'jsx']],
    ['src/echo.tsx', ['export function Echo(): JSX.Element { return <p/>; }\n',
      'export function Echo(): JSX.Element { return <span/>; }\n', 'tsx']],
    ['src/foxtrot.svelte', ['{#snippet Foxtrot()}<p>x</p>{/snippet}\n',
      '{#snippet Foxtrot()}<p>y</p>{/snippet}\n', 'svelte5']],
    ['src/green.svelte.js', ['export function green() { return 1; }\n',
      'export function green() { return 2; }\n', 'javascript']],
    ['src/harbor.svelte.ts', ['export function harbor(): number { return 1; }\n',
      'export function harbor(): number { return 2; }\n', 'typescript']],
  ]);
  let inputOid = '';
  for (const [path, [before]] of paths) inputOid = await f.commit(f.root, path, before);
  for (const [path, [, after]] of paths) await writeFile(join(f.root, path), after);
  const entries = [...paths];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const selected = entries.slice(offset, offset + 4);
    const receipt = await runtime.coordinate(f.registerRequest({ input_oid: inputOid,
      areas: selected.map(([path]) => ({ kind: 'file', path })) }), owner, f.root);
    const response = await runtime.structuralReport(receipt.receipt.item_id, owner, f.root);
    assert.deepEqual(response.reports.map(row => [row.path, row.dialect]),
      selected.map(([path, [, , dialect]]) => [path, dialect]));
    assert.deepEqual(response.limitations, []);
    for (const row of response.reports) {
      assert.match(row.text, /body_changed \(body omitted\)/, row.path);
      assert.match(row.text, /source bytes: \d+\.\.\d+/, row.path);
    }
    await runtime.coordinate(command({ kind: 'close_work', operation_key: key(),
      work_id: receipt.receipt.item_id, expected_revision: 1 }), owner, f.root);
  }
});
