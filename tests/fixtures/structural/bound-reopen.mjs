// Controlled process fixture, not a public tool or authentication substitute.
import { readFile } from 'node:fs/promises';
import { CoordinationStore } from '../../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../../.passeur-core/src/coordination/control.js';
import { RepositoryCoordination } from '../../../.passeur-core/src/coordination/bound-control.js';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const store = await CoordinationStore.open(request.state, request.repository_id, () => {});
const control = new CoordinationControl(store);
const bound = await RepositoryCoordination.open(request.root, control,
  { async assertExternalRegistration(_actor, workspace) { if (!request.external_roots.includes(workspace.root)) throw Error('Fixture source not admitted'); } },
  { max_worktrees: 64, max_source_operations: 2 });
try {
  const result = request.mode === 'receipt' ? await bound.receipt(request.actor, request.operation_key)
    : await bound.execute({ ...request.actor, source_view: request.source_view }, request.command);
  if (request.exit_after_acceptance) process.exit(74);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1;
} finally { await bound.close(); }
