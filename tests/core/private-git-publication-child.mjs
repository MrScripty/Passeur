import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { replayPrivatePublication } from '../../.passeur-core/src/workspace/worktree.js';
import { atomicJson } from '../../.passeur-core/src/store/atomic-json.js';

const { state, root, intent, identity, boundary } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const store = new TaskStore(state);
await store.beginPrivatePublication(intent);
if (boundary === 'intent') process.exit(77);
if (boundary === 'zero' || boundary === 'partial') {
  const publication = intent.publication;
  await atomicJson(join(publication.quarantine_path, 'index-lock-owner.json'),
    { head: publication.new_head, index: publication.new_index_sha256 });
  const suffix = createHash('sha256').update(`${publication.new_head}:${publication.new_index_sha256}`).digest('hex');
  const file = await open(`${publication.canonical_admin_path}/index.passeur-${suffix}`, 'wx', 0o600);
  try {
    if (boundary === 'partial') await file.writeFile((await readFile(join(publication.quarantine_path, 'index'))).subarray(0, 16));
    await file.sync();
  } finally { await file.close(); }
  process.exit(77);
}
let checkpoints = 0;
const assertAuthority = () => {
  checkpoints++;
  // The publication code calls this after import, then after ref CAS.
  if (boundary === 'import' && checkpoints === 2 || boundary === 'prepared' && checkpoints === 7 ||
      boundary === 'ref' && checkpoints === 13) process.exit(77);
};
if (boundary === 'index' || boundary === 'settlement') {
  const original = store.settlePrivatePublication.bind(store);
  store.settlePrivatePublication = async (...args) => {
    if (boundary === 'index') process.exit(77);
    const result = await original(...args);
    process.exit(77);
    return result;
  };
}
await replayPrivatePublication(store, root, identity, 'confirmed', assertAuthority);
