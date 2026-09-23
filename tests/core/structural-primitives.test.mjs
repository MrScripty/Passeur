import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, access, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from '../../.passeur-core/src/workspace/project.js';
import { readCommittedFile, captureWorkingFile, sourceReference, sourceExcerpt, validateSourcePath } from '../../.passeur-core/src/observation/source.js';
import { compareExtractions } from '../../.passeur-core/src/observation/match.js';
import { renderComparison, renderReportPage } from '../../.passeur-core/src/observation/report.js';
import { noticeMateriality } from '../../.passeur-core/src/coordination/notices.js';

const run = promisify(execFile);
const max = { max_bytes: 4096 };
const sha = text => createHash('sha256').update(text).digest('hex');
async function repository(t, format = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'passeur-source-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  await git(repo, ['init', `--object-format=${format}`, '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Passeur source fixture']);
  await git(repo, ['config', 'user.email', 'source@example.invalid']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repo, 'source.ts'), 'function cancel(id: string): void {}\n');
  const commit = async message => { await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', message]); return (await git(repo, ['rev-parse', 'HEAD'])).trim(); };
  const base = await commit('test: initial source');
  t.after(async () => {
    // Every commit and path here belongs to this intentionally disposable fixture; there are no user worktrees.
    const common = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    assert.equal(common, join(repo, '.git'));
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await rm(root, { recursive: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,
      JSON.stringify({ test: t.name, root, head, outcome: 'removed-discard-authorized-test-fixture' }) + '\n');
  });
  const workspace = { root: repo, workspace_id: 'fixture', workspace_generation: 1, capture_sequence: 1 };
  return { root, repo, base, commit, workspace };
}

for (const format of ['sha1', 'sha256']) {
  test(`exact ${format} commit bytes are independent of dirty checkout and current HEAD`, async t => {
    const f = await repository(t, format);
    await writeFile(join(f.repo, 'source.ts'), 'function replacement(): string { return "new"; }\n');
    await f.commit('test: later version');
    await writeFile(join(f.repo, 'source.ts'), 'uncommitted data');
    const file = await readCommittedFile(f.repo, f.base, 'source.ts', max);
    assert.equal(file.status, 'present');
    assert.equal(file.text, 'function cancel(id: string): void {}\n');
    assert.equal(file.source.commit_oid, f.base);
    assert.equal(file.source.object_format, format);
    assert.equal(file.consistency, 'immutable_git_blob');
    assert.equal(file.content_sha256, sha(file.text));
    assert.equal(file.blob_oid.length, format === 'sha1' ? 40 : 64);
    assert.ok(Object.isFrozen(file) && Object.isFrozen(file.source));
  });
}

test('working captures retain their own bytes and context after another edit', async t => {
  const f = await repository(t);
  const text = '\uFEFFconst 名 = "é";\n';
  await writeFile(join(f.repo, 'source.ts'), text);
  const captured = await captureWorkingFile(f.workspace, 'source.ts', max);
  assert.equal(captured.status, 'present');
  assert.equal(captured.text, text);
  assert.equal(captured.byte_length, Buffer.byteLength(text));
  assert.equal(captured.source.head_anchor, f.base);
  assert.equal(captured.consistency, 'sampled_file_not_atomic');
  await writeFile(join(f.repo, 'source.ts'), 'new bytes');
  assert.equal(sourceExcerpt(captured, { start_byte: 0, end_byte: captured.byte_length }), text);
  assert.throws(() => sourceExcerpt(captured, { start_byte: 1, end_byte: 2 }), { code: 'SOURCE_RANGE_INVALID' });
  const ref = sourceReference(captured);
  assert.equal('text' in ref, false);
  assert.equal(ref.content_sha256, captured.content_sha256);
});

test('commit absence and missing live source have different observations', async t => {
  const f = await repository(t);
  assert.equal((await readCommittedFile(f.repo, f.base, 'missing.ts', max)).status, 'absent_in_commit');
  assert.equal((await captureWorkingFile(f.workspace, 'missing.ts', max)).status, 'missing_during_capture');
  assert.equal((await captureWorkingFile(f.workspace, 'missing/source.ts', max)).status, 'missing_during_capture');
});

test('source sampling does not follow final symlinks or intermediate directory symlinks', async t => {
  const f = await repository(t);
  const external = join(f.root, 'outside'); await mkdir(external);
  await writeFile(join(external, 'secret.ts'), 'outside captured authority');
  await symlink(join(external, 'secret.ts'), join(f.repo, 'link.ts'));
  await symlink(external, join(f.repo, 'linked'));
  const final = await captureWorkingFile(f.workspace, 'link.ts', max);
  assert.equal(final.status, 'non_source'); assert.equal(final.entry_kind, 'symlink');
  assert.equal('text' in final, false);
  await assert.rejects(captureWorkingFile(f.workspace, 'linked/secret.ts', max), { code: 'SOURCE_PATH_UNSAFE' });
  const commit = await f.commit('test: symlink entries');
  const stored = await readCommittedFile(f.repo, commit, 'link.ts', max);
  assert.equal(stored.status, 'non_source'); assert.equal(stored.entry_kind, 'symlink');
  assert.equal(sourceReference(stored).mode, '120000');
});

test('directories and nonblocking special-file observations expose no source bytes', { timeout: 5000 }, async t => {
  const f = await repository(t); await mkdir(join(f.repo, 'directory'));
  await writeFile(join(f.repo, 'directory', 'child'), 'data');
  await run('mkfifo', [join(f.repo, 'pipe')]);
  const pipe = await captureWorkingFile(f.workspace, 'pipe', max);
  assert.equal(pipe.status, 'non_source'); assert.equal(pipe.entry_kind, 'special');
  const directory = await captureWorkingFile(f.workspace, 'directory', max);
  assert.equal(directory.entry_kind, 'directory');
  // Git cannot index a FIFO; exclude it from the fixture commit rather than changing production behavior.
  await rm(join(f.repo, 'pipe'));
  const commit = await f.commit('test: directory entry');
  assert.equal((await readCommittedFile(f.repo, commit, 'directory', max)).entry_kind, 'directory');
});

test('invalid paths are rejected before access, while literal Git pathspec characters remain literal', async t => {
  const f = await repository(t);
  for (const path of ['', '../secret', '/absolute', '.git/config', 'a/../b', 'a//b', 'a\0b', '\ud800']) {
    assert.throws(() => validateSourcePath(path), { code: 'SOURCE_PATH_INVALID' });
  }
  const path = 'odd[*]\n.ts'; await writeFile(join(f.repo, path), 'literal file\n');
  const commit = await f.commit('test: literal source path');
  assert.equal((await readCommittedFile(f.repo, commit, path, max)).text, 'literal file\n');
});

test('UTF-8 byte identity survives Git reads; invalid encodings are not lossy source observations', async t => {
  const f = await repository(t);
  await writeFile(join(f.repo, 'valid.ts'), '\uFEFFconst 名 = "é";\n');
  await writeFile(join(f.repo, 'invalid.ts'), Buffer.from([0xff, 0xfe, 0x41]));
  const commit = await f.commit('test: encodings');
  assert.equal((await readCommittedFile(f.repo, commit, 'valid.ts', max)).text, '\uFEFFconst 名 = "é";\n');
  await assert.rejects(readCommittedFile(f.repo, commit, 'invalid.ts', max), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
  await assert.rejects(captureWorkingFile(f.workspace, 'invalid.ts', max), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
});

test('source budgets and explicit cancellation reject without starting a usable observation', async t => {
  const f = await repository(t);
  await assert.rejects(readCommittedFile(f.repo, f.base, 'source.ts', { max_bytes: 1 }), { code: 'SOURCE_TOO_LARGE' });
  await assert.rejects(captureWorkingFile(f.workspace, 'source.ts', { max_bytes: 1 }), { code: 'SOURCE_TOO_LARGE' });
  await assert.rejects(captureWorkingFile(f.workspace, 'source.ts', { max_bytes: 0 }), { code: 'SOURCE_LIMIT_INVALID' });
  const controller = new AbortController(); const reason = new Error('cancel observation only'); controller.abort(reason);
  await assert.rejects(captureWorkingFile(f.workspace, 'source.ts', { ...max, signal: controller.signal }), error => error === reason);
});

test('commit observation rejects annotated tag objects and ignores Git replacement refs', async t => {
  const f = await repository(t);
  await git(f.repo, ['tag', '-a', 'sample', '-m', 'test tag']);
  const tag = (await git(f.repo, ['rev-parse', 'sample'])).trim();
  await assert.rejects(readCommittedFile(f.repo, tag, 'source.ts', max), { code: 'SOURCE_COMMIT_REQUIRED' });
  await writeFile(join(f.repo, 'source.ts'), 'replacement\n'); const replacement = await f.commit('test: replacement');
  await git(f.repo, ['replace', f.base, replacement]);
  const original = await readCommittedFile(f.repo, f.base, 'source.ts', max);
  assert.equal(original.text, 'function cancel(id: string): void {}\n');
});

test('direct blob observation invokes no configured text converter or external diff', async t => {
  const f = await repository(t);
  const marker = join(f.root, 'unexpected-helper'); const script = join(f.root, 'helper');
  await writeFile(script, `#!/bin/sh\nprintf invoked > '${marker}'\n`); await chmod(script, 0o700);
  await git(f.repo, ['config', 'diff.external', script]);
  await git(f.repo, ['config', 'diff.danger.textconv', script]);
  await writeFile(join(f.repo, '.gitattributes'), '*.ts diff=danger\n');
  const commit = await f.commit('test: configured external tools');
  assert.equal((await readCommittedFile(f.repo, commit, 'source.ts', max)).status, 'present');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('committed source inspection never lazily fetches a missing promisor blob', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-promisor-'));
  const origin = join(root, 'origin'), clone = join(root, 'clone'); await mkdir(origin);
  t.after(async () => { await rm(root, { recursive: true }); await assert.rejects(access(root), { code: 'ENOENT' }); });
  await git(origin, ['init', '-b', 'main']);
  await git(origin, ['config', 'user.name', 'Passeur promisor fixture']);
  await git(origin, ['config', 'user.email', 'source@example.invalid']);
  await git(origin, ['config', 'commit.gpgsign', 'false']);
  await git(origin, ['config', 'uploadpack.allowFilter', 'true']);
  await writeFile(join(origin, 'source.ts'), 'export const remoteOnly = true;\n');
  await git(origin, ['add', 'source.ts']); await git(origin, ['commit', '-m', 'test: promisor source']);
  const commit = (await git(origin, ['rev-parse', 'HEAD'])).trim();
  const blob = (await git(origin, ['rev-parse', 'HEAD:source.ts'])).trim();
  await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', `file://${origin}`, clone]);
  const localOnly = { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } };
  await assert.rejects(run('git', ['-C', clone, 'cat-file', '-e', blob], localOnly));
  await assert.rejects(readCommittedFile(clone, commit, 'source.ts', max), { code: 'GIT_ERROR' });
  await assert.rejects(run('git', ['-C', clone, 'cat-file', '-e', blob], localOnly));
});

// These fixtures are independently authored extraction values, NOT a parser substitute or proof of language support.
function declaration(options = {}) {
  return { key: 'cancel', kind: 'method', name: 'cancel', enclosing: ['Provider'],
    range: { start_byte: 0, end_byte: 50 }, signature: 'cancel(id: string): void',
    parameters: ['id: string'], result: { state: 'declared', syntax: 'void' }, header_complete: true,
    body_digest: sha('body0'), default_digests: [], ...options };
}
function extraction(declarations = [declaration()], options = {}) {
  return { dialect: 'typescript', parser_identity: 'hand-authored-fixture-not-parser', extractor_identity: 'fixture-v1',
    source: { source: { kind: 'commit', repository_id: 'test-repo', object_format: 'sha1', commit_oid: 'a'.repeat(40), tree_oid: 'b'.repeat(40), path: 'src/provider.ts' },
      status: 'present', content_sha256: sha('input'), byte_length: 4096, mode: '100644', consistency: 'immutable_git_blob' },
    coverage: 'complete', declarations, remainder_digest: sha('outside'), limitations: [], ...options };
}
function observed(declarations = [declaration()], options = {}) {
  const e = extraction(declarations, options);
  return { ...e, source: { ...e.source, content_sha256: sha('observed'), source: { ...e.source.source, commit_oid: 'c'.repeat(40) } } };
}
const attributed = comparison => ({ work_id: 'task-A', parent_id: 'parent-A', attribution: 'observed_in_work_authorship_not_established', comparison });

test('matching shows written parameter/result changes against independently identified versions', () => {
  const a = extraction(); const b = observed([declaration({ signature: 'cancel(id: RequestId): CancelReceipt', parameters: ['id: RequestId'], result: { state: 'declared', syntax: 'CancelReceipt' } })]);
  const result = compareExtractions(a, b);
  assert.equal(result.input.source.commit_oid, 'a'.repeat(40));
  assert.equal(result.observed.source.commit_oid, 'c'.repeat(40));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'modified');
  assert.equal(result.changes[0].correspondence, 'unique_syntax_correspondence');
  assert.equal(result.changes[0].declaration_changed, true);
  assert.equal(result.changes[0].observed.result.syntax, 'CancelReceipt');
  b.declarations[0].signature = 'mutated caller alias';
  assert.equal(result.changes[0].observed.signature, 'cancel(id: RequestId): CancelReceipt');
  assert.ok(Object.isFrozen(result.changes[0].observed.parameters));
});

test('body-only changes remain visible without literal body/default source', () => {
  const result = compareExtractions(extraction(), observed([declaration({ body_digest: sha('secret body changed') })]));
  assert.equal(result.changes[0].declaration_changed, false);
  assert.equal(result.changes[0].body_changed, true);
  const rendered = renderComparison(attributed(result));
  assert.match(rendered, /body_changed \(body omitted\)/);
  assert.match(rendered, /declaration_unchanged/);
  assert.equal(rendered.includes('secret body'), false);
  assert.equal(rendered.includes(sha('secret body changed')), false);
});

test('default-only changes keep the marker but not default literals or hashes in the report', () => {
  const d = { signature: 'cancel(id: string = <default>): void', parameters: ['id: string = <default>'] };
  const result = compareExtractions(extraction([declaration({ ...d, default_digests: [sha('token1')] })]),
    observed([declaration({ ...d, default_digests: [sha('token2')] })]));
  assert.equal(result.changes[0].default_changed, true);
  assert.equal(result.changes[0].declaration_changed, false);
  const rendered = renderComparison(attributed(result));
  assert.match(rendered, /concealed_header_changed/);
  assert.equal(rendered.includes('token1'), false); assert.equal(rendered.includes('token2'), false);
});

test('unwritten return types stay not_declared rather than acquiring inferred annotations', () => {
  const d = declaration({ signature: 'function cancel(id)', parameters: ['id'], result: { state: 'not_declared' } });
  const report = renderComparison(attributed(compareExtractions(extraction([d]), observed([{ ...d, body_digest: sha('body1') }]))));
  assert.match(report, /result: not_declared/);
  assert.equal(report.includes('result: "void"'), false);
});

test('unique unchanged overloads match before a remaining changed overload', () => {
  const a = declaration({ key: 'a', signature: 'cancel(id: string): void' });
  const b = declaration({ key: 'b', signature: 'cancel(id: number): void', parameters: ['id: number'] });
  const b2 = { ...b, key: 'b-next', signature: 'cancel(id: bigint): void', parameters: ['id: bigint'] };
  const r = compareExtractions(extraction([a, b]), observed([b2, { ...a, key: 'a-next' }]));
  assert.equal(r.changes.length, 1); assert.equal(r.changes[0].input.key, 'b'); assert.equal(r.changes[0].observed.key, 'b-next');
});

test('duplicate signatures are ambiguous rather than paired by occurrence order', () => {
  const a = [declaration({ key: 'a' }), declaration({ key: 'b', body_digest: sha('other') })];
  const b = [declaration({ key: 'c', body_digest: sha('third') }), declaration({ key: 'd' })];
  const r = compareExtractions(extraction(a), observed(b));
  assert.equal(r.changes.length, 4);
  assert.ok(r.changes.every(c => c.kind === 'ambiguous' && c.correspondence === 'ambiguous'));
  assert.equal(r.coverage, 'incomplete');
});

test('absent input supports additions while incomplete and missing observations never prove deletion', () => {
  const empty = extraction([]); empty.source = { source: empty.source.source, status: 'absent_in_commit' };
  const added = compareExtractions(empty, observed()); assert.equal(added.changes[0].kind, 'added');
  const bad = observed([], { coverage: 'incomplete', limitations: ['parse error in changed region'] });
  const incomplete = compareExtractions(extraction(), bad);
  assert.equal(incomplete.changes[0].kind, 'unobserved');
  const missing = extraction([]); missing.source = { source: { kind: 'working_capture', repository_id: 'test-repo', object_format: 'sha1',
    workspace_id: 'w', workspace_generation: 1, capture_id: 'capture', capture_sequence: 1, head_anchor: 'a'.repeat(40), path: 'src/provider.ts' }, status: 'missing_during_capture' };
  const r = compareExtractions(extraction(), missing);
  assert.equal(r.coverage, 'unavailable'); assert.equal(r.changes[0].kind, 'unobserved');
  const removed = compareExtractions(extraction(), empty); assert.equal(removed.changes[0].kind, 'removed');
});

test('an incomplete declaration header is not claimed as a confirmed header change', () => {
  const r = compareExtractions(extraction(), observed([declaration({ signature: 'cancel(', header_complete: false })], { coverage: 'incomplete' }));
  assert.equal(r.changes[0].kind, 'unobserved'); assert.equal(r.changes[0].declaration_changed, false);
  assert.match(renderComparison(attributed(r)), /declaration extraction incomplete/);
});

test('unmapped edits and executable mode changes remain visible', () => {
  assert.equal(compareExtractions(extraction(), observed([declaration()], { remainder_digest: sha('new top-level statement') })).region_changed, true);
  const executable = observed(); executable.source.mode = '100755';
  assert.equal(compareExtractions(extraction(), executable).region_changed, true);
  const uncertain = observed(); delete uncertain.remainder_digest;
  assert.equal(compareExtractions(extraction(), uncertain).region_changed, true);
});

test('different repositories, paths or extraction identities are rejected as comparison pairs', () => {
  for (const mutate of [e => { e.source.source.repository_id = 'other'; }, e => { e.source.source.path = 'other.ts'; }, e => { e.parser_identity = 'other'; }]) {
    const b = observed(); mutate(b); assert.throws(() => compareExtractions(extraction(), b), { code: 'STRUCTURAL_PAIR_INVALID' });
  }
  assert.throws(() => compareExtractions(extraction([declaration(), declaration()]), observed()), { code: 'STRUCTURAL_EXTRACTION_INVALID' });
});

test('three tasks keep their own input/observed labels and report attribution rather than blame', () => {
  const reports = [0, 1, 2].map(n => {
    const a = extraction(); a.source.source.commit_oid = String(n + 1).repeat(40);
    const r = attributed(compareExtractions(a, observed([declaration({ signature: `cancel(id: T${n}): void` })])));
    return { ...r, work_id: `task-${n}`, parent_id: `parent-${n}` };
  });
  const page = renderReportPage(reports, 0, 65536);
  assert.equal(page.entries.length, 3); assert.equal(page.complete, true);
  for (let n = 0; n < 3; n++) {
    assert.match(page.entries[n].text, new RegExp(`INPUT — commit ${String(n + 1).repeat(40)}`));
    assert.match(page.entries[n].text, /OBSERVED — commit c{40}/);
    assert.match(page.entries[n].text, /exclusive authorship is not established/);
  }
});

test('page budgets count serialized escaping bytes and make forward progress', () => {
  const one = attributed(compareExtractions(extraction(), observed([declaration({ body_digest: sha('new') })])));
  const reports = [one, { ...one, work_id: 'second' }];
  const firstSize = Buffer.byteLength(JSON.stringify(renderReportPage([one], 0, 65536))) + 1;
  const first = renderReportPage(reports, 0, firstSize);
  assert.equal(first.entries.length, 1); assert.equal(first.next_offset, 1); assert.equal(first.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= firstSize);
  assert.equal(renderReportPage(reports, first.next_offset, 65536).complete, true);
  assert.throws(() => renderReportPage(reports, 0, 128), { code: 'STRUCTURAL_ENTRY_TOO_LARGE' });
  assert.throws(() => renderReportPage(reports, 3, 1024), { code: 'STRUCTURAL_PAGE_INVALID' });
});

test('untrusted source labels cannot add terminal control sequences or spoof line-oriented headings', () => {
  const a = extraction(); a.source.source.path = 'source\nOBSERVED fake\u001b[2J.ts';
  const b = observed([declaration({ name: 'cancel\u202e', signature: 'cancel()\nFAKE: approved\u001b[2J' })]); b.source.source.path = a.source.source.path;
  const text = renderComparison({ ...attributed(compareExtractions(a, b)), parent_id: 'p\u009b' });
  assert.equal(text.includes('\u001b'), false); assert.equal(text.includes('\u202e'), false); assert.equal(text.includes('\u009b'), false);
  assert.ok(text.includes('\\nOBSERVED fake')); assert.equal(text.includes('\nFAKE: approved'), false);
});

test('notice materiality ignores OID/position/body-digest churn but changes for new structure or reversion', () => {
  const a = extraction();
  const first = attributed(compareExtractions(a, observed([declaration({ body_digest: sha('first') })])));
  const nextInput = observed([declaration({ body_digest: sha('second'), range: { start_byte: 20, end_byte: 70 } })]);
  nextInput.source.source.commit_oid = 'd'.repeat(40);
  const second = attributed(compareExtractions(a, nextInput));
  assert.equal(noticeMateriality(first), noticeMateriality(second));
  const newHeader = attributed(compareExtractions(a, observed([declaration({ signature: 'cancel(id: number): void', body_digest: sha('second') })])));
  assert.notEqual(noticeMateriality(first), noticeMateriality(newHeader));
  const unchanged = attributed(compareExtractions(a, a));
  assert.notEqual(noticeMateriality(first), noticeMateriality(unchanged));
});


test('source operations reject a subdirectory as an ambiguous registered worktree root', async t => {
  const f = await repository(t); const nested = join(f.repo, 'nested'); await mkdir(nested);
  await writeFile(join(nested, 'source.ts'), 'nested bytes');
  await assert.rejects(readCommittedFile(nested, f.base, 'source.ts', max), { code: 'SOURCE_WORKSPACE_ROOT_INVALID' });
  await assert.rejects(captureWorkingFile({ ...f.workspace, root: nested }, 'source.ts', max), { code: 'SOURCE_WORKSPACE_ROOT_INVALID' });
});
