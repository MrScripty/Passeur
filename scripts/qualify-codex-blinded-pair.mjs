#!/usr/bin/env node
/** Disposable, retained two-worker qualification. Live mode requires an explicit gate. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'tests', 'fixture-apps', 'python');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' } }).trim();
const names = ['main.py', 'quote.py', 'display.py'];
const sourceHashes = Object.freeze({
  'main.py': '4691d8f711f958168e0069176b351d27b2b9d3483f29a9db371b4d2ccc611ca7',
  'quote.py': '56191c8031466a224eea7732a49d178aa0af44f84c9ef14a6f7e63e3d3051c66',
  'display.py': '2b711d1b9ddba334f3aeeb754bdc79718dc333d7ff69f79ded3b6e1a782ee2d2',
});

// These are literal pre-feature bytes. The source digest check ties them to the L04
// application; the baseline deliberately has neither worker's requested feature.
export const BASELINE = Object.freeze({
  'quote.py': `from dataclasses import dataclass

MAX_UNIT_CENTS = 1_000_000
MAX_QUANTITY = 1_000


@dataclass(frozen=True)
class Order:
    unit_cents: int
    quantity: int


@dataclass(frozen=True)
class Quote:
    subtotal_cents: int
    total_cents: int


def _parse_bounded(value: str, maximum: int) -> int:
    if not value or not value.isascii() or not value.isdecimal():
        raise ValueError("expected unsigned decimal integer")
    parsed = int(value)
    if parsed > maximum:
        raise ValueError("integer out of range")
    return parsed


def parse_order(args: list[str]) -> Order:
    if len(args) != 2:
        raise ValueError("expected unit_cents quantity")
    return Order(
        unit_cents=_parse_bounded(args[0], MAX_UNIT_CENTS),
        quantity=_parse_bounded(args[1], MAX_QUANTITY),
    )


def calculate_quote(order: Order) -> Quote:
    subtotal = order.unit_cents * order.quantity
    return Quote(subtotal, subtotal)
`,
  'display.py': `from quote import Quote


def format_quote(quote: Quote) -> str:
    return (
        f"subtotal_cents={quote.subtotal_cents}\\n"
        f"total_cents={quote.total_cents}"
    )
`,
  'main.py': `import sys

from display import format_quote
from quote import calculate_quote, parse_order


def main(args: list[str]) -> int:
    try:
        order = parse_order(args)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(format_quote(calculate_quote(order)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
`,
});

export const ASSIGNMENTS = Object.freeze([
  Object.freeze({ key: 'discount', objective: 'Add an optional percentage discount to the quote calculator',
    context: 'Extend the console app with a third unsigned decimal argument, discount_bps (0 through 10000). Keep the existing two-argument call valid with a zero discount. Compute discount_cents as floor(subtotal_cents * discount_bps / 10000). Print discount_cents and a total that subtracts it. Keep integer cents, current input bounds, and existing error behavior. Work in main.py, quote.py, and display.py as needed. Run the app checks and commit the completed change on the assigned branch.',
    acceptance_criteria: ['Two-argument calls still work', '1000 bps on 1250 cents times 3 deducts 375 cents',
      'The output itemizes the discount and the final total', 'Commit the completed app change'] }),
  Object.freeze({ key: 'delivery', objective: 'Add an optional flat delivery charge to the quote calculator',
    context: 'Extend the console app with an optional --delivery-cents VALUE flag after the ordinary numeric arguments. Validate VALUE as an unsigned decimal from 0 through 1000000; default to zero when the flag is absent. Print delivery_cents as its own line and include it in total_cents. Keep integer cents, current input bounds, and existing error behavior. Work in main.py, quote.py, and display.py as needed. Run the app checks and commit the completed change on the assigned branch.',
    acceptance_criteria: ['Two-argument calls still work', 'A 125-cent delivery charge is included once in the total',
      'The output itemizes the delivery charge and the final total', 'Commit the completed app change'] }),
]);

export const COMBINED_ORACLE = Object.freeze({ input: ['2500', '4', '2000', '--delivery-cents', '500'],
  fields: Object.freeze({ subtotal_cents: 10000, discount_cents: 2000, delivery_cents: 500, total_cents: 8500 }),
  defaults: Object.freeze({ subtotal_cents: 10000, discount_cents: 0, delivery_cents: 0, total_cents: 10000 }) });

export function promptFor(part) {
  return { schema_version: 3, agent_id: 'codex', request_key: part.request_key,
    mode: 'implement', objective: part.objective,
    context: `${part.context} Use this fixture Git identity for the commit: git -c user.name='Passeur Fixture' -c user.email='passeur-fixture@example.invalid' commit. Return a schema-2 PASSEUR_MESSAGE final envelope with summary, assessment, blockers, questions, and checks.`,
    acceptance_criteria: part.acceptance_criteria, allowed_paths: [...names],
    base_commit: part.base_commit, target_ref: 'refs/heads/main' };
}

export function assertBlindness(prompts, heldCanaries) {
  const words = ['blinded', 'pair', 'sibling', 'peer', 'overlap', 'conflict', 'compromise', 'negotiat', 'poll passeur'];
  for (const [index, prompt] of prompts.entries()) {
    const text = JSON.stringify(prompt).toLowerCase();
    if (words.some(word => text.includes(word)) || heldCanaries.some(value => text.includes(value.toLowerCase())) ||
        text.includes(ASSIGNMENTS[1 - index].objective.toLowerCase())) throw Error('Initial worker prompt discloses held scenario');
  }
}

export async function prepareFixture() {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-work-'));
  const project = join(root, 'project'), vault = join(root, 'vault');
  await mkdir(project, { mode: 0o700 }); await mkdir(vault, { mode: 0o700 });
  for (const name of names) {
    const bytes = await readFile(join(source, name));
    if (sha(bytes) !== sourceHashes[name]) throw Error(`L04 source digest changed: ${name}`);
    await writeFile(join(project, name), BASELINE[name]);
  }
  const corpusHash = sha(names.map(name => `${name}\0${sha(BASELINE[name])}`).join('\n'));
  const held = [randomUUID(), randomUUID()];
  const plan = ASSIGNMENTS.map((part, index) => ({ ...part, request_key: `task-${randomUUID()}`,
    held_canary: held[index] }));
  await writeFile(join(vault, 'assignments.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(vault, 'combined-oracle.json'), `${JSON.stringify(COMBINED_ORACLE, null, 2)}\n`, { mode: 0o600 });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Passeur Fixture');
  git(project, 'config', 'user.email', 'passeur-fixture@example.invalid');
  git(project, 'config', 'commit.gpgsign', 'false');
  git(project, 'add', '--', ...names); git(project, 'commit', '-qm', 'test: pre-feature L04 baseline');
  const base = git(project, 'rev-parse', 'HEAD');
  await writeFile(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nset -eu\nprintf hook-ran > "$(git rev-parse --git-common-dir)/hooks/fixture-hook-marker"\n');
  await chmod(join(project, '.git', 'hooks', 'pre-commit'), 0o755);
  const prompts = plan.map(part => promptFor({ ...part, base_commit: base }));
  assertBlindness(prompts, held);
  const manifest = { schema_version: 1, root, project, base, no_remote: git(project, 'remote') === '',
    baseline_sha256: corpusHash, plan_sha256: sha(await readFile(join(vault, 'assignments.json'))),
    oracle_sha256: sha(await readFile(join(vault, 'combined-oracle.json'))),
    prompt_sha256: prompts.map(prompt => sha(JSON.stringify(prompt))), status: 'prepared' };
  if (!manifest.no_remote) throw Error('Disposable fixture unexpectedly has a remote');
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(root, 'bounded-report.json'), `${JSON.stringify({ schema_version: 1,
    status: 'prepared_only', root, base, baseline_sha256: corpusHash,
    plan_sha256: manifest.plan_sha256, oracle_sha256: manifest.oracle_sha256,
    prompt_sha256: manifest.prompt_sha256, no_remote: true,
    native_execution: 'not_started', accepted_task_ids: [],
    qualification: 'nonpassing_retained',
    next_gate: 'reviewed shared-service single-worker admission before pair submission' }, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function classifyPair(evidence) {
  const keys = ['blind', 'baseline', 'no_remote', 'overlapping_native_execution', 'automatic_overlap',
    'source_grounded_handoff', 'proposal', 'counterproposal', 'distinct_consent', 'exact_version_application',
    'hooked_commits', 'combined_oracle', 'confirmed_stops', 'protected_canaries', 'retained_resources'];
  return keys.every(key => evidence[key] === true) ? 'pair_passed' : 'nonpassing_retained';
}

export function oracleOutput(stdout, expected) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n')) return false;
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length !== 4) return false;
  const parsed = Object.create(null);
  for (const line of lines) {
    const match = /^([a-z_]+)=([0-9]+)$/.exec(line);
    if (!match || Object.hasOwn(parsed, match[1])) return false;
    parsed[match[1]] = match[2];
  }
  return Object.keys(expected).length === Object.keys(parsed).length &&
    Object.entries(expected).every(([key, value]) => parsed[key] === String(value));
}

export function registeredProfile(root, codexBin, codexHome) {
  return { schema_version: 3, execution: { stop_grace_ms: 5000, max_workers: 2,
    max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
    max_control_receipts: 512, implementation: { enabled: true, worktree_root: join(root, 'worktrees') } },
  agents: [{ agent_id: 'codex', adapter_id: 'codex', description: 'Disposable Codex implementation worker', enabled: true,
    options: { codex_bin: codexBin, codex_home: codexHome, model: 'gpt-6-astra', network_access: true,
      allow_command_escalation: false, use_caller_codex_home: true, experimental_real_protected: true,
      subscription_confirmed: true, experimental_opt_in: true } }] };
}

// Provider execution must use the shared service lifecycle. This offline fixture
// intentionally has no standalone runtime path that could strand accepted tasks.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [operation, extra] = process.argv.slice(2);
  try {
    if (operation !== '--prepare' || extra) throw Error('Use --prepare for a retained offline fixture');
    console.log(JSON.stringify(await prepareFixture()));
  } catch (error) { console.error(error?.code ?? error?.message ?? 'fixture preparation failed'); process.exitCode = 1; }
}
