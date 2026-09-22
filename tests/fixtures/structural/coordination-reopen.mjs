// Real child-process publication/reopen probe. This is never a production runtime.
import { readFile } from 'node:fs/promises';
import { CoordinationStore } from '../../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../../.passeur-core/src/coordination/control.js';
const [root, mode, requestFile] = process.argv.slice(2);
const { repository, actor, command } = JSON.parse(await readFile(requestFile, 'utf8'));
let calls = 0;
const authority = () => {
  calls++;
  // execute assertion, publish assertion, then the four original atomicJson authority checks.
  if (mode === 'interrupt-before-rename' && calls === 6) process.exit(73);
};
const store = await CoordinationStore.open(root, repository, authority);
const control = new CoordinationControl(store);
const receipt = await control.execute(actor, command);
if (mode === 'lose-receipt') process.exit(74);
await control.close();
process.stdout.write(JSON.stringify(receipt));
