import { readFile } from 'node:fs/promises';
import { CoordinationService } from '../../../.passeur-core/src/service/coordination.js';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const forbidden = async () => { throw Error('This read-only fixture authorizes no mutation or source lookup'); };
const session = new CoordinationService({ store_root: input.state, repository_id: input.repository }, {
  assertOwned() { throw Error('This fixture owns no mutation authority'); }, authorizeInitialization: forbidden,
  externalWorkspaces: { assertExternalRegistration: forbidden },
}, { ordinary_requests: 2, control_requests: 2, max_source_operations: 1, max_worktrees: 32 });
try {
  let offset = 0, hash = null, contents = '';
  while (true) {
    const reply = await session.handle({ owner_id: input.owner, source_view: input.source }, {
      schema_version: 1, kind: 'read', selector: { kind: 'work', id: input.work }, offset, limit: 512, expected_hash: hash,
    });
    contents += reply.content; offset = reply.next_offset; hash = reply.hash;
    if (reply.eof) break;
  }
  process.stdout.write(contents);
} finally { await session.close(); }
