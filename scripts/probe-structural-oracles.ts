import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type OracleOptions = Readonly<{
  installed: string;
  fixtures: string;
  stagingRoot: string;
  project: string;
  runInstalledNode: (args: string[]) => Promise<string>;
}>;

type CorpusRow = Readonly<{ id: string; stem: string; dialect: string; input: string;
  changed: string; incomplete: string; expected: Record<string, unknown> }>;
type Variant = Readonly<{ id: string; stem: string; variant: string; dialect: string;
  input: string; changed: string; expectedFile: string; expected: Record<string, unknown> }>;

// This program runs inside the installed runtime mount. Its only inputs are
// copied source bytes and the installed extraction/comparison modules.
const installedProgram = String.raw`
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [payloadPath, installedRoot] = process.argv.slice(1);
const { extractNativeFunctions } = await import(pathToFileURL(join(installedRoot, 'dist/src/observation/native-extraction.js')).href);
const { compareExtractions } = await import(pathToFileURL(join(installedRoot, 'dist/src/observation/match.js')).href);
const { loadNativeParser } = await import(pathToFileURL(join(installedRoot, 'dist/src/observation/native-parser.js')).href);
const rows = JSON.parse(readFileSync(payloadPath, 'utf8'));
const capture = (text, path, sequence) => ({ status: 'present', text, mode: '100644',
  content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
  consistency: 'sampled_file_not_atomic', source: { kind: 'working_capture', repository_id: 'installed-oracle',
    object_format: 'sha1', workspace_id: 'installed-oracle', workspace_generation: 1,
    capture_id: 'installed-oracle-' + sequence, capture_sequence: sequence, head_anchor: 'a'.repeat(40), path } });
const output = [];
for (const row of rows) {
  const input = await extractNativeFunctions(capture(row.input, row.path, 1), row.dialect);
  const changed = await extractNativeFunctions(capture(row.changed, row.path, 2), row.dialect);
  const incomplete = row.incomplete === undefined ? null :
    await extractNativeFunctions(capture(row.incomplete, row.path, 3), row.dialect);
  const comparison = compareExtractions(input, changed);
  const incompleteComparison = incomplete === null ? null : compareExtractions(input, incomplete);
  let nativeNodes;
  if (row.variant === 'edition_2024') {
    const { parser } = await loadNativeParser(row.dialect);
    const tree = parser.parse(row.input);
    nativeNodes = { has_error: tree.rootNode.hasError, types: tree.rootNode.namedChildren.map(node => node.type) };
  }
  output.push({ id: row.id, variant: row.variant, dialect: row.dialect,
    input, changed, incomplete, comparison, incompleteComparison, nativeNodes });
}
process.stdout.write(JSON.stringify(output));
`;

const specs = [
  ["L01", "rust"], ["L02", "typescript"], ["L03", "javascript"], ["L04", "python"],
  ["L05", "lua"], ["L06", "kotlin"], ["L07", "zig"], ["L08", "csharp"],
  ["L09", "c"], ["L10", "cpp"], ["L11", "odin"], ["L12", "svelte5"],
  ["L13", "react"],
] as const;
const canonicalAssertedKeys: Record<string, readonly string[]> = {
  L01: ["input_declarations", "changes", "incomplete_limitations"],
  L02: ["input_declarations", "changes", "incomplete_limitations"],
  L03: ["input_declarations", "input_ranges", "changed_ranges", "changed", "incomplete_limitations"],
  L04: ["coverage", "declarations", "changed", "incomplete_limitations"],
  L05: ["coverage", "declarations", "changed", "incomplete_limitations"],
  L06: ["input_declarations", "changes", "incomplete_limitations"],
  L07: ["input_declarations", "changes", "incomplete_limitations"],
  L08: ["names", "kinds", "record_parameters", "method_enclosing", "method_signature",
    "method_parameters", "method_result", "property_initializer_digests", "first_start_byte",
    "first_source", "limitations"],
  L09: ["names", "kinds", "sum_signature", "sum_parameters", "sum_result", "first_start_byte",
    "first_source", "selected_branch_count", "limitations"],
  L10: ["names", "kinds", "choose_signature", "choose_parameters", "choose_result", "run_enclosing",
    "run_result", "first_start_byte", "first_source", "limitations"],
  L11: ["input_declarations", "changes", "incomplete_limitations"],
  L12: ["input_declarations", "input_ranges", "changed_ranges", "changed", "region_changed",
    "incomplete_limitations"],
  L13: ["jsx_declarations", "jsx_input_ranges", "jsx_changed_ranges", "jsx_body_only",
    "incomplete_limitations"],
};

export type PublicOracleCase = Readonly<{ id: string; variant: "canonical"; dialect: string;
  path: string; input: string; changed: string; incomplete: string;
  expected: Readonly<{
    input_names: readonly string[]; input_signatures: readonly string[];
    changed_names: readonly string[]; incomplete_limitations: readonly string[] | null;
    changed_flags: Readonly<Record<string, Readonly<{ declaration_changed?: boolean;
      body_changed?: boolean; default_changed?: boolean }>>>;
    changed_sections: readonly Readonly<{ name: string; kind: "modified";
      declaration_changed?: boolean; body_changed?: boolean; default_changed?: boolean }>[];
    unchanged_signatures_for_changed_names: Readonly<Record<string, string>>;
    redacted_literals: readonly string[];
    changed_limitations: null;
    incomplete_limitations_exact: boolean;
    input_coverage: "complete" | "incomplete"; changed_coverage: "complete" | "incomplete";
    public_input_coverage: "complete" | "incomplete";
    public_changed_coverage: "complete" | "incomplete";
  }> }>;
export type PublicOracleVariantCase = Readonly<Omit<PublicOracleCase,
  "variant" | "incomplete"> & { variant: string; incomplete: null; override?: "jsx" }>;

/** Authored fixture expectations for the installed CLI/MCP Git-report exercise. */
async function allPublicOracleCases(fixtures: string): Promise<readonly (PublicOracleCase | PublicOracleVariantCase)[]> {
  const output: (PublicOracleCase | PublicOracleVariantCase)[] = [];
  for (const [id, stem] of specs) {
    const base = join(resolve(fixtures), stem);
    const cases = JSON.parse(await readFile(join(base, "cases.json"), "utf8")) as Record<string, string>;
    const expected = JSON.parse(await readFile(join(base, cases.expectations ?? "expected.json"), "utf8")) as any;
    const inputFile = cases.input ?? cases.source ?? cases.jsx_input;
    const changedFile = cases.changed ?? cases.jsx_changed;
    assert.ok(inputFile && changedFile && cases.incomplete, `${id} public canonical fixture files`);
    const declarations: any[] = expected.input_declarations ?? expected.declarations ??
      expected.jsx_declarations ?? [];
    const names: string[] = expected.names ?? declarations.map(d => Array.isArray(d) ? d[1] : d.name);
    const signatures: string[] = declarations.map(d => Array.isArray(d) ? d[3] : d.signature);
    if (id === "L08") signatures.push(expected.method_signature);
    if (id === "L09") signatures.push(expected.sum_signature);
    if (id === "L10") signatures.push(expected.choose_signature);
    const changedNames: string[] = Array.isArray(expected.changes) ? expected.changes.map((c: any[]) =>
      id === "L06" || id === "L07" || id === "L11" ? c[1] : c[0]) :
      expected.changed ? Object.keys(expected.changed) :
      id === "L08" ? ["Run"] : id === "L09" ? ["sum"] : id === "L10" ? ["run"] :
      id === "L13" ? ["Card"] : [];
    const changedFlags: Record<string, { declaration_changed?: boolean; body_changed?: boolean;
      default_changed?: boolean }> = {};
    if (Array.isArray(expected.changes)) for (const change of expected.changes as any[][]) {
      const offset = ["L06", "L07", "L11"].includes(id) ? 1 : 0;
      changedFlags[String(change[offset])] = { declaration_changed: change[offset + 1],
        body_changed: change[offset + 2], default_changed: change[offset + 3] };
    }
    else if (["L04", "L05"].includes(id)) Object.assign(changedFlags, expected.changed);
    else if (id === "L03") changedFlags.stream = { body_changed: expected.changed.stream[1],
      default_changed: expected.changed.stream[0] };
    else if (id === "L12") changedFlags.card = { body_changed: expected.changed.card[1],
      default_changed: expected.changed.card[0] };
    else if (id === "L13") changedFlags.Card = { declaration_changed: expected.jsx_body_only[0],
      body_changed: expected.jsx_body_only[1], default_changed: expected.jsx_body_only[2] };
    // Canonical C-family fixture tests author these exact marker assertions.
    else if (id === "L08") changedFlags.Run = { declaration_changed: false,
      body_changed: false, default_changed: true };
    else if (id === "L09") changedFlags.sum = { declaration_changed: false,
      body_changed: true, default_changed: false };
    else if (id === "L10") changedFlags.run = { declaration_changed: false,
      body_changed: true, default_changed: false };
    const unchangedSignatures: Record<string, string> = {};
    for (const declaration of declarations) {
      const name = String(Array.isArray(declaration) ? declaration[1] : declaration.name);
      const signature = String(Array.isArray(declaration) ? declaration[3] : declaration.signature);
      if (changedNames.includes(name) && changedFlags[name]?.declaration_changed === false)
        unchangedSignatures[name] = signature;
    }
    assert.ok(names.length > 0 && signatures.length > 0 && changedNames.length > 0,
      `${id} public expectation projection must be authored`);
    const redacted: Record<string, readonly string[]> = {
      L03: ["\"secret\""],
      L04: ["private decorator argument", "private_type", "secret_value", "private_field"],
      L08: ["\"secret\"", "Route(\"private\")"],
    };
    output.push({ id, variant: "canonical", dialect: cases.dialect ?? cases.jsx_dialect ?? stem,
      path: `${id}-canonical-${basename(inputFile)}`,
      input: await readFile(join(base, inputFile), "utf8"),
      changed: await readFile(join(base, changedFile), "utf8"),
      incomplete: await readFile(join(base, cases.incomplete), "utf8"),
      expected: { input_names: names, input_signatures: signatures, changed_names: changedNames,
        changed_flags: changedFlags, unchanged_signatures_for_changed_names: unchangedSignatures,
        changed_sections: changedNames.map(name => ({ name, kind: "modified" as const,
          ...changedFlags[name] })), redacted_literals: redacted[id] ?? [],
        changed_limitations: null,
        // Public comparison adds limitations beyond the extraction oracle.
        incomplete_limitations_exact: false,
        incomplete_limitations: expected.incomplete_limitations ?? null,
        input_coverage: expected.coverage ?? (expected.limitations?.length ? "incomplete" : "complete"),
        changed_coverage: expected.limitations?.length ? "incomplete" : "complete",
        // match.ts marks a comparison incomplete when any declaration lacks a
        // direct body digest. Canonical L04–L11 include such declarations;
        // C23 also carries its authored unresolved preprocessor alternatives.
        public_input_coverage: ["L04", "L05", "L06", "L07", "L08", "L09", "L10", "L11"].includes(id)
          ? "incomplete" : "complete",
        public_changed_coverage: ["L04", "L05", "L06", "L07", "L08", "L09", "L10", "L11"].includes(id)
          ? "incomplete" : "complete" } });
  }
  const addPublicVariant = async (id: string, stem: string, variant: string, dialect: string,
    inputFile: string, changedFile: string, declarations: any[], changeRows: any[][],
    offset: number, override?: "jsx"): Promise<void> => {
    const base = join(resolve(fixtures), stem);
    const names = declarations.map(d => String(d[1]));
    const signatures = declarations.map(d => String(d[3]));
    const flags: Record<string, { declaration_changed: boolean; body_changed: boolean;
      default_changed: boolean }> = {};
    for (const c of changeRows) flags[String(c[offset])] = {
      declaration_changed: Boolean(c[offset + 1]), body_changed: Boolean(c[offset + 2]),
      default_changed: Boolean(c[offset + 3]) };
    const unchanged: Record<string, string> = {};
    for (const d of declarations) if (flags[String(d[1])]?.declaration_changed === false)
      unchanged[String(d[1])] = String(d[3]);
    const sections = changeRows.map(c => ({ name: String(c[offset]), kind: "modified" as const,
      declaration_changed: Boolean(c[offset + 1]), body_changed: Boolean(c[offset + 2]),
      default_changed: Boolean(c[offset + 3]) }));
    output.push({ id, variant, dialect, path: `${id}-${variant}-${basename(inputFile)}`,
      input: await readFile(join(base, inputFile), "utf8"),
      changed: await readFile(join(base, changedFile), "utf8"), incomplete: null,
      ...(override ? { override } : {}),
      expected: { input_names: names, input_signatures: signatures,
        changed_names: sections.map(section => section.name), changed_flags: flags,
        changed_sections: sections,
        redacted_literals: variant === "configured_jsx_js" ? ["\"secret\""] : [],
        changed_limitations: null, incomplete_limitations_exact: false,
        unchanged_signatures_for_changed_names: unchanged, incomplete_limitations: null,
        input_coverage: "complete", changed_coverage: "complete",
        public_input_coverage: "complete", public_changed_coverage: "complete" } });
  };
  const fixture = async (stem: string): Promise<{ cases: Record<string, string>; expected: any }> => {
    const base = join(resolve(fixtures), stem);
    const cases = JSON.parse(await readFile(join(base, "cases.json"), "utf8")) as Record<string, string>;
    const expected = JSON.parse(await readFile(join(base, cases.expectations ?? "expected.json"), "utf8"));
    return { cases, expected };
  };
  const rust = await fixture("rust");
  await addPublicVariant("L01", "rust", "population", "rust", rust.cases.population!,
    rust.cases.population_changed!, rust.expected.population_declarations,
    rust.expected.population_changes, 1);
  const ts = await fixture("typescript");
  for (const ext of ["mts", "cts"] as const) await addPublicVariant("L02", "typescript",
    `population_${ext}`, "typescript", ts.cases[`population_${ext}`]!,
    ts.cases[`population_${ext}_changed`]!, ts.expected[`population_${ext}_declarations`],
    ts.expected[`population_${ext}_changes`], 1);
  const svelte = await fixture("svelte5");
  for (const [key, dialect] of [["script_js", "javascript"], ["script_ts", "typescript"]] as const) {
    const d = svelte.expected[key];
    await addPublicVariant("L12", "svelte5", key, dialect, svelte.cases[key]!,
      svelte.cases[`${key}_changed`]!, [[d[0], d[1], [], d[2]]],
      [[d[1], false, true, true]], 0);
  }
  const react = await fixture("react");
  await addPublicVariant("L13", "react", "tsx", "tsx", react.cases.tsx_input!,
    react.cases.tsx_changed!, react.expected.tsx_declarations,
    [[react.expected.tsx_declarations[0][1], ...react.expected.tsx_body_only]], 0);
  const configured = react.expected.configured_jsx_js;
  await addPublicVariant("L13", "react", "configured_jsx_js", "jsx", react.cases.configured_jsx_js!,
    react.cases.configured_jsx_js_changed!, [[configured[0], configured[1], [], configured[2]]],
    [[configured[1], false, true, false]], 0, "jsx");
  return output;
}

export async function publicOracleCases(fixtures: string): Promise<readonly PublicOracleCase[]> {
  return (await allPublicOracleCases(fixtures)).filter((row): row is PublicOracleCase =>
    row.variant === "canonical");
}

export async function publicOracleVariantCases(fixtures: string): Promise<readonly PublicOracleVariantCase[]> {
  return (await allPublicOracleCases(fixtures)).filter((row): row is PublicOracleVariantCase =>
    row.variant !== "canonical");
}

function tuple(declaration: any, withRange = false): unknown[] {
  const base = [declaration.kind, declaration.name, declaration.enclosing, declaration.signature];
  if (withRange) base.push(declaration.range.start_byte, declaration.range.end_byte);
  return base;
}
function changeTuple(change: any): unknown[] {
  return [change.observed?.name ?? change.input?.name, change.declaration_changed,
    change.body_changed, change.default_changed];
}
function assertLimitations(actual: string[], expected: unknown, id: string, exact: boolean): void {
  assert.equal(Array.isArray(expected), true, `${id} must define incomplete limitations`);
  if (exact) { assert.deepEqual(actual, expected, `${id} exact incomplete limitations`); return; }
  for (const limitation of expected as string[]) assert.ok(actual.includes(limitation), `${id}: missing ${limitation}`);
}
function checkRow(row: CorpusRow, result: any): Record<string, unknown> {
  const { input, changed, incomplete, comparison, incompleteComparison } = result;
  const expected = row.expected as any;
  assert.equal(result.id, row.id);
  assert.equal(result.dialect, row.dialect);
  assert.equal(input.coverage, expected.coverage ?? (expected.limitations?.length ? "incomplete" : "complete"),
    `${row.id} input coverage`);
  assert.equal(changed.coverage, expected.limitations?.length ? "incomplete" : "complete",
    `${row.id} changed coverage`);
  assert.equal(incomplete.coverage, "incomplete", `${row.id} malformed coverage`);
  if (expected.incomplete_limitations) assertLimitations(incomplete.limitations,
    expected.incomplete_limitations, row.id, ["L04", "L05", "L06", "L07", "L11"].includes(row.id));
  assert.equal(incompleteComparison.coverage, "incomplete", `${row.id} malformed comparison coverage`);
  assert.ok(incompleteComparison.limitations.includes("comparison_coverage_incomplete"),
    `${row.id} malformed comparison must mark incomplete correspondence`);
  const declarations = input.declarations as any[];
  const changes = comparison.changes as any[];
  if (expected.input_declarations) {
    assert.deepEqual(declarations.map(d => tuple(d, ["L06", "L07", "L11"].includes(row.id))),
      expected.input_declarations, `${row.id} declarations`);
  }
  if (expected.input_ranges) assert.deepEqual(declarations.map(d => [d.range.start_byte, d.range.end_byte]),
    expected.input_ranges, `${row.id} input byte ranges`);
  if (expected.changed_ranges) assert.deepEqual((changed.declarations as any[]).map(d =>
    [d.range.start_byte, d.range.end_byte]), expected.changed_ranges, `${row.id} changed byte ranges`);
  if (expected.names) {
    assert.deepEqual(declarations.map(d => d.name), expected.names, `${row.id} names`);
    assert.deepEqual(declarations.map(d => d.kind), expected.kinds, `${row.id} kinds`);
    assert.deepEqual(input.limitations, expected.limitations, `${row.id} input limitations`);
    assert.equal(declarations[0]?.range.start_byte, expected.first_start_byte, `${row.id} first byte`);
    assert.equal(declarations[0]?.range.end_byte,
      expected.first_start_byte + Buffer.byteLength(expected.first_source), `${row.id} last byte`);
    const firstText = Buffer.from(row.input).subarray(declarations[0].range.start_byte,
      declarations[0].range.end_byte).toString("utf8");
    assert.equal(firstText, expected.first_source, `${row.id} source byte slice`);
    const changedName = row.id === "L08" ? "Run" : row.id === "L09" ? "sum" : "run";
    assert.ok(changes.some(c => (c.observed?.name ?? c.input?.name) === changedName),
      `${row.id} changed declaration absent`);
    if (row.id === "L08") {
      assert.deepEqual(changes.map(c => [c.kind, c.observed?.name ?? c.input?.name,
        c.declaration_changed, c.body_changed, c.default_changed]),
      [["modified", "Run", false, false, true]], `${row.id} exact canonical change`);
      assert.deepEqual(declarations[1].parameters, expected.record_parameters);
      assert.deepEqual(declarations[3].enclosing, expected.method_enclosing);
      assert.equal(declarations[3].signature, expected.method_signature);
      assert.deepEqual(declarations[3].parameters, expected.method_parameters);
      assert.deepEqual(declarations[3].result, { state: "declared", syntax: expected.method_result });
      assert.equal(declarations[4].default_digests.length, expected.property_initializer_digests);
      const before = declarations.find(d => d.name === "Run" && d.body_digest);
      const after = changed.declarations.find((d: any) => d.name === "Run" && d.body_digest);
      assert.ok(before && after);
      assert.notDeepEqual(before.default_digests, after.default_digests);
      assert.equal(before.body_digest, after.body_digest);
    } else if (row.id === "L09") {
      assert.deepEqual(changes.map(c => [c.kind, c.observed?.name ?? c.input?.name,
        c.declaration_changed, c.body_changed, c.default_changed]),
      [["modified", "sum", false, true, false]], `${row.id} exact canonical change`);
      assert.equal(declarations[0].signature, expected.sum_signature);
      assert.deepEqual(declarations[0].parameters, expected.sum_parameters);
      assert.deepEqual(declarations[0].result, { state: "declared", syntax: expected.sum_result });
      assert.equal(declarations.filter(d => d.name === "selected").length, expected.selected_branch_count);
      const before = declarations.find(d => d.name === "sum" && d.body_digest);
      const after = changed.declarations.find((d: any) => d.name === "sum" && d.body_digest);
      assert.ok(before && after);
      assert.notEqual(before.body_digest, after.body_digest);
      assert.equal(before.signature, after.signature);
    } else {
      assert.deepEqual(changes.map(c => [c.kind, c.observed?.name ?? c.input?.name,
        c.declaration_changed, c.body_changed, c.default_changed]),
      [["modified", "run", false, true, false]], `${row.id} exact canonical change`);
      assert.equal(declarations[1].signature, expected.choose_signature);
      assert.deepEqual(declarations[1].parameters, expected.choose_parameters);
      assert.deepEqual(declarations[1].result, { state: "declared", syntax: expected.choose_result });
      assert.deepEqual(declarations[5].enclosing, expected.run_enclosing);
      assert.deepEqual(declarations[5].result, { state: "declared", syntax: expected.run_result });
      const before = declarations.find(d => d.name === "run" && d.body_digest);
      const after = changed.declarations.find((d: any) => d.name === "run" && d.body_digest);
      assert.ok(before && after);
      assert.notEqual(before.body_digest, after.body_digest);
      assert.equal(before.signature, after.signature);
    }
  }
  if (["L01", "L02"].includes(row.id)) assert.deepEqual(changes.map(changeTuple)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))), expected.changes, `${row.id} changes`);
  if (["L06", "L07", "L11"].includes(row.id)) assert.deepEqual(changes.map(c =>
    [c.kind, ...changeTuple(c)]), expected.changes, `${row.id} changes`);
  if (["L04", "L05"].includes(row.id)) {
    assert.equal(declarations.length, expected.declarations.length, `${row.id} declaration count`);
    for (const [index, wanted] of expected.declarations.entries()) {
      const d = declarations[index];
      assert.deepEqual({ kind: d.kind, name: d.name, enclosing: d.enclosing, range: d.range,
        signature: d.signature, parameters: d.parameters, result: d.result,
        default_count: d.default_digests.length },
      { kind: wanted.kind, name: wanted.name, enclosing: wanted.enclosing, range: wanted.range,
        signature: wanted.signature, parameters: wanted.parameters, result: wanted.result,
        default_count: wanted.default_count }, `${row.id} declaration ${index}`);
      if (wanted.direct_body_text) assert.equal(d.body_digest,
        createHash("sha256").update(wanted.direct_body_text).digest("hex"),
        `${row.id} declaration ${index} direct body digest`);
    }
    assert.equal(changes.length, Object.keys(expected.changed).length, `${row.id} change count`);
    for (const c of changes) assert.deepEqual({ declaration_changed: c.declaration_changed,
      body_changed: c.body_changed, default_changed: c.default_changed },
    expected.changed[c.observed?.name ?? c.input?.name], `${row.id} change flags`);
  }
  if (row.id === "L03") {
    assert.deepEqual(changes.map(c => [c.kind, c.observed?.name ?? c.input?.name,
      c.declaration_changed, c.body_changed, c.default_changed]),
      [["modified", "stream", false, true, true]], `${row.id} exact canonical changes`);
    assert.deepEqual(changes.find(c => (c.input ?? c.observed)?.name === "stream") &&
      [changes.find(c => (c.input ?? c.observed)?.name === "stream").default_changed,
        changes.find(c => (c.input ?? c.observed)?.name === "stream").body_changed],
      expected.changed.stream, `${row.id} generator markers`);
  }
  if (row.id === "L12") {
    assert.deepEqual(changes.map(c => [c.kind, c.observed?.name ?? c.input?.name,
      c.declaration_changed, c.body_changed, c.default_changed]),
      [["modified", "card", false, true, true]], `${row.id} exact canonical changes`);
    const snippet = changes.find(c => (c.input ?? c.observed)?.name === "card");
    assert.deepEqual([snippet?.default_changed, snippet?.body_changed], expected.changed.card,
      `${row.id} snippet markers`);
    assert.equal(comparison.region_changed, expected.region_changed, `${row.id} region marker`);
  }
  if (row.id === "L13") {
    assert.deepEqual(declarations.map(d => tuple(d)), expected.jsx_declarations, `${row.id} JSX declarations`);
    assert.deepEqual(declarations.map(d => [d.range.start_byte, d.range.end_byte]),
      expected.jsx_input_ranges, `${row.id} JSX ranges`);
    assert.deepEqual((changed.declarations as any[]).map(d => [d.range.start_byte, d.range.end_byte]),
      expected.jsx_changed_ranges, `${row.id} changed JSX ranges`);
    assert.deepEqual(changes.map(c => [c.declaration_changed, c.body_changed, c.default_changed]),
      [expected.jsx_body_only], `${row.id} JSX body change`);
    assert.ok(incomplete.declarations.every((d: any) => !d.header_complete &&
      d.signature === "<header extraction incomplete>"), `${row.id} malformed header disclosure`);
  }
  return { row: row.id, dialect: row.dialect,
    asserted_keys: canonicalAssertedKeys[row.id],
    assertion_scope: { incomplete_limitations: ["L04", "L05", "L06", "L07", "L11"].includes(row.id)
      ? "exact" : expected.incomplete_limitations ? "required_subset" : "not_authored" },
    fixture_bytes: { input: Buffer.byteLength(row.input), changed: Buffer.byteLength(row.changed),
      incomplete: Buffer.byteLength(row.incomplete) },
    fixture_sha256: { input: createHash("sha256").update(row.input).digest("hex"),
      changed: createHash("sha256").update(row.changed).digest("hex"),
      incomplete: createHash("sha256").update(row.incomplete).digest("hex") },
    checked_transitions: ["input→changed", "input→incomplete"],
    input_declarations: declarations.length,
    changed_declarations: changes.length, incomplete_comparison_changes: incompleteComparison.changes.length,
    input_coverage: input.coverage,
    incomplete_coverage: incomplete.coverage, incomplete_limitations: incomplete.limitations,
    incomplete_limitation_oracle: expected.incomplete_limitations ? "authored" : "not_authored_in_expected_json" };
}

function checkVariant(row: Variant, result: any): Record<string, unknown> {
  assert.equal(result.id, row.id);
  assert.equal(result.variant, row.variant);
  assert.equal(result.dialect, row.dialect);
  const input = result.input, changed = result.changed, comparison = result.comparison;
  const declarations = input.declarations as any[], changes = comparison.changes as any[];
  const expected = row.expected as any;
  const checked: string[] = [];
  const verify = (key: string, actual: unknown, wanted: unknown): void => {
    assert.deepEqual(actual, wanted, `${row.id} ${row.variant} ${key}`);
    checked.push(key);
  };
  const names = () => declarations.map(d => d.name);
  const kinds = () => declarations.map(d => d.kind);
  const ranges = (items: any[]) => items.map(d => [d.range.start_byte, d.range.end_byte]);
  const changeFlags = () => changes.map(c => [c.observed?.kind ?? c.input?.kind,
    c.observed?.name ?? c.input?.name, c.declaration_changed, c.body_changed, c.default_changed]);
  assert.equal(input.coverage, "complete", `${row.id} ${row.variant} input coverage`);
  assert.equal(changed.coverage, "complete", `${row.id} ${row.variant} changed coverage`);
  if (row.variant === "edition_2024") {
    assert.equal(declarations.length, expected.edition_2024_declarations.length);
    verify("edition_2024_native_nodes", result.nativeNodes, {
      has_error: false, types: expected.edition_2024_native_nodes });
    verify("edition_2024_declarations", declarations.map(d => tuple(d)), expected.edition_2024_declarations);
    verify("edition_2024_ranges", ranges(declarations), expected.edition_2024_ranges);
    verify("edition_2024_coverage", input.coverage, "complete");
  } else if (row.variant === "population") {
    assert.equal(declarations.length, expected.population_declarations.length);
    verify("population_declarations", declarations.map(d => tuple(d)), expected.population_declarations);
    verify("population_changes", changeFlags(), expected.population_changes);
    verify("population_region_changed", comparison.region_changed, expected.population_region_changed);
  } else if (row.variant.startsWith("population_")) {
    assert.equal(declarations.length, expected[`${row.variant}_declarations`].length);
    verify(`${row.variant}_declarations`, declarations.map(d => tuple(d)),
      expected[`${row.variant}_declarations`]);
    verify(`${row.variant}_changes`, changeFlags(), expected[`${row.variant}_changes`]);
  } else if (row.variant === "ambiguous") {
    verify("ambiguous_change_count", changes.length, expected.ambiguous_change_count);
    assert.ok(changes.every(c => c.kind === "ambiguous"), `${row.id} ambiguous correspondence`);
    assert.ok(comparison.limitations.includes("declaration_correspondence_ambiguous"));
  } else if (row.variant === "added") {
    verify("added_name", changes.map(c => [c.kind, c.observed?.name]), [["added", expected.added_name]]);
  } else if (row.variant === "advanced" || row.variant === "context") {
    assert.equal(declarations.length, expected[`${row.variant}_declarations`].length);
    verify(`${row.variant}_declarations`, declarations.map(d => [d.kind, d.name, d.signature,
      d.range.start_byte, d.range.end_byte]), expected[`${row.variant}_declarations`]);
  } else if (row.variant === "modern") {
    assert.equal(declarations.length, expected.names.length);
    verify("names", names(), expected.names);
    verify("types", declarations.map(d => d.result.syntax), expected.types);
    verify("number_signature", declarations[1].signature, expected.number_signature);
    verify("nullish_parameters", declarations[2].parameters, expected.nullish_parameters);
  } else if (row.variant === "bitint") {
    assert.equal(declarations.length, 1, `${row.id} bitint declaration count`);
    verify("name", declarations[0]?.name, expected.name);
    verify("kind", declarations[0]?.kind, expected.kind);
    verify("signature", declarations[0]?.signature, expected.signature);
    verify("result", declarations[0]?.result, { state: "declared", syntax: expected.result });
    verify("range", declarations[0]?.range, expected.range);
  } else if (row.variant === "explicit_object") {
    assert.equal(declarations.length, 2, `${row.id} explicit object declaration count`);
    verify("container_name", declarations[0]?.name, expected.container_name);
    verify("container_kind", declarations[0]?.kind, expected.container_kind);
    verify("name", declarations[1]?.name, expected.name);
    verify("kind", declarations[1]?.kind, expected.kind);
    verify("signature", declarations[1]?.signature, expected.signature);
    verify("parameters", declarations[1]?.parameters, expected.parameters);
    verify("result", declarations[1]?.result, { state: "declared", syntax: expected.result });
    verify("enclosing", declarations[1]?.enclosing, expected.enclosing);
  } else if (row.variant === "extension_block") {
    assert.equal(declarations.length, expected.names.length);
    verify("names", names(), expected.names);
    verify("kinds", kinds(), expected.kinds);
    verify("receiver", declarations[1]?.parameters, expected.receiver);
    verify("property_enclosing", declarations[2]?.enclosing, expected.property_enclosing);
    verify("property_result", declarations[2]?.result, { state: "declared", syntax: expected.property_result });
  } else if (row.variant === "script_js" || row.variant === "script_ts") {
    assert.equal(declarations.length, 1, `${row.id} ${row.variant} declaration count`);
    const e = expected[row.variant];
    verify(row.variant, [declarations[0]?.kind, declarations[0]?.name, declarations[0]?.signature,
      [declarations[0]?.range.start_byte, declarations[0]?.range.end_byte]], e);
    verify(`${row.variant}_changed_range`, ranges(changed.declarations),
      [expected[`${row.variant}_changed_range`]]);
  } else if (row.variant === "nested") {
    verify("nested_declarations", declarations.map(d => [d.name, d.enclosing]), expected.nested_declarations);
    verify("nested_changes", changes.map(c => [c.observed?.name, c.observed?.enclosing, c.body_changed]),
      [["row", ["outer"], true]]);
  } else if (row.variant === "tsx") {
    assert.equal(declarations.length, expected.tsx_declarations.length);
    verify("tsx_declarations", declarations.map(d => tuple(d)), expected.tsx_declarations);
    verify("tsx_input_ranges", ranges(declarations), expected.tsx_input_ranges);
    verify("tsx_changed_ranges", ranges(changed.declarations), expected.tsx_changed_ranges);
    verify("tsx_body_only", changes.map(c => [c.declaration_changed, c.body_changed, c.default_changed]),
      [expected.tsx_body_only]);
  } else if (row.variant === "configured_jsx_js") {
    assert.equal(declarations.length, 1, `${row.id} configured JSX declaration count`);
    verify("configured_jsx_js", [declarations[0]?.kind, declarations[0]?.name, declarations[0]?.signature,
      [declarations[0]?.range.start_byte, declarations[0]?.range.end_byte]], expected.configured_jsx_js);
    verify("configured_jsx_js_changed_range", ranges(changed.declarations),
      [expected.configured_jsx_js_changed_range]);
  } else throw new Error(`No installed oracle for ${row.id} ${row.variant}`);
  assert.ok(checked.length > 0, `${row.id} ${row.variant} has no authored assertion`);
  return { row: row.id, variant: row.variant, dialect: row.dialect, asserted_keys: checked,
    fixture_bytes: { input: Buffer.byteLength(row.input), changed: Buffer.byteLength(row.changed) },
    fixture_sha256: { input: createHash("sha256").update(row.input).digest("hex"),
      changed: createHash("sha256").update(row.changed).digest("hex") },
    input_coverage: input.coverage, changed_coverage: changed.coverage,
    changed_declarations: changes.length };
}

export async function probeStructuralOracles(options: OracleOptions): Promise<Record<string, unknown>> {
  const corpus: CorpusRow[] = [];
  const variants: Variant[] = [];
  const caseMap = new Map<string, Record<string, string>>();
  for (const [id, stem] of specs) {
    const base = join(resolve(options.fixtures), stem);
    const cases = JSON.parse(await readFile(join(base, "cases.json"), "utf8")) as Record<string, string>;
    caseMap.set(stem, cases);
    const expected = JSON.parse(await readFile(join(base, cases.expectations ?? "expected.json"), "utf8")) as Record<string, unknown>;
    const inputPath = cases.input ?? cases.source ?? cases.jsx_input;
    const changedPath = cases.changed ?? cases.jsx_changed;
    const incompletePath = cases.incomplete;
    assert.ok(inputPath && changedPath && incompletePath, `${id} canonical input/changed/incomplete files`);
    corpus.push({ id, stem, dialect: cases.dialect ?? (stem === "react" ? "jsx" : stem),
      input: await readFile(join(base, inputPath), "utf8"),
      changed: await readFile(join(base, changedPath), "utf8"),
      incomplete: await readFile(join(base, incompletePath), "utf8"), expected });
  }
  const addVariant = async (id: string, stem: string, variant: string, dialect: string,
    inputFile: string, changedFile = inputFile, expectedFile = "expected.json"): Promise<void> => {
    const base = join(resolve(options.fixtures), stem);
    variants.push({ id, stem, variant, dialect, expectedFile,
      input: await readFile(join(base, inputFile), "utf8"),
      changed: await readFile(join(base, changedFile), "utf8"),
      expected: JSON.parse(await readFile(join(base, expectedFile), "utf8")) as Record<string, unknown> });
  };
  const c = (stem: string, key: string): string => {
    const value = caseMap.get(stem)?.[key];
    assert.ok(value, `${stem} canonical ${key} fixture`);
    return value;
  };
  await addVariant("L01", "rust", "edition_2024", "rust", c("rust", "edition_2024"));
  await addVariant("L01", "rust", "population", "rust", c("rust", "population"), c("rust", "population_changed"));
  for (const ext of ["mts", "cts"]) await addVariant("L02", "typescript", `population_${ext}`,
    "typescript", c("typescript", `population_${ext}`), c("typescript", `population_${ext}_changed`));
  for (const [id, stem] of [["L04", "python"], ["L05", "lua"]] as const) {
    await addVariant(id, stem, "ambiguous", stem, c(stem, "ambiguous_before"), c(stem, "ambiguous_after"));
    await addVariant(id, stem, "added", stem, c(stem, "added_before"), c(stem, "added_after"));
  }
  for (const [id, stem] of [["L06", "kotlin"], ["L07", "zig"], ["L11", "odin"]] as const)
    await addVariant(id, stem, "advanced", stem, c(stem, "advanced"));
  await addVariant("L06", "kotlin", "context", "kotlin", c("kotlin", "context"));
  await addVariant("L09", "c", "modern", "c", "modern.c", "modern.c", "modern-expected.json");
  await addVariant("L09", "c", "bitint", "c", "bitint.c", "bitint.c", "bitint-expected.json");
  await addVariant("L10", "cpp", "explicit_object", "cpp", "explicit-object.cpp",
    "explicit-object.cpp", "explicit-object-expected.json");
  await addVariant("L08", "csharp", "extension_block", "csharp", "extension-block.cs",
    "extension-block.cs", "extension-block-expected.json");
  await addVariant("L12", "svelte5", "script_js", "javascript", c("svelte5", "script_js"),
    c("svelte5", "script_js_changed"));
  await addVariant("L12", "svelte5", "script_ts", "typescript", c("svelte5", "script_ts"),
    c("svelte5", "script_ts_changed"));
  await addVariant("L12", "svelte5", "nested", "svelte5", c("svelte5", "nested"),
    c("svelte5", "nested_changed"));
  await addVariant("L13", "react", "tsx", "tsx", c("react", "tsx_input"), c("react", "tsx_changed"));
  await addVariant("L13", "react", "configured_jsx_js", "jsx", c("react", "configured_jsx_js"),
    c("react", "configured_jsx_js_changed"));
  const payloadPath = join(resolve(options.stagingRoot), "installed-semantic-oracle-corpus.json");
  await mkdir(resolve(options.stagingRoot), { recursive: true });
  await writeFile(payloadPath, JSON.stringify([...corpus, ...variants].map(row => ({ id: row.id,
    variant: "variant" in row ? row.variant : "canonical", dialect: row.dialect,
    path: `${row.id}-${row.stem}-${"variant" in row ? row.variant : "canonical"}`,
    input: row.input, changed: row.changed,
    ...("incomplete" in row ? { incomplete: row.incomplete } : {}) }))));
  const output = JSON.parse(await options.runInstalledNode(["--input-type=module", "-e", installedProgram,
    payloadPath, resolve(options.installed)])) as unknown[];
  assert.equal(output.length, corpus.length + variants.length, "Installed runtime must return every canonical and variant row");
  const checkedRows = corpus.map((row, index) => checkRow(row, output[index]));
  const checkedVariants = variants.map((row, index) => checkVariant(row, output[corpus.length + index]));
  for (const row of corpus) {
    const accounted = new Set([...canonicalAssertedKeys[row.id] ?? [],
      ...checkedVariants.filter(v => v.row === row.id).flatMap(v => v.asserted_keys as string[])]);
    const missing = Object.keys(row.expected).filter(key => !accounted.has(key));
    assert.deepEqual(missing, [], `${row.id} expected.json has fields without installed assertions`);
  }
  for (const variant of variants.filter(v => v.expectedFile !== "expected.json")) {
    const checked = checkedVariants.find(v => v.row === variant.id && v.variant === variant.variant)!;
    const missing = Object.keys(variant.expected).filter(key => !(checked.asserted_keys as string[]).includes(key));
    assert.deepEqual(missing, [], `${variant.id} ${variant.variant} expected JSON has unasserted fields`);
  }
  return { schema_version: 2, rows: checkedRows,
    variants: checkedVariants,
    native_parser: "installed", comparison: "installed", fixture_oracles: "canonical_expected_json",
    child_source_checkout_visible: false };
}
