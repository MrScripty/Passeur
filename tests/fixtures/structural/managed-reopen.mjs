// Real metadata-store reopening; the principal/source descriptors are explicit controlled fixtures.
import { readFile } from 'node:fs/promises';
import { CoordinationStore } from '../../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../../.passeur-core/src/coordination/control.js';
const [root,requestFile,mode]=process.argv.slice(2);
const {repository,actor,command}=JSON.parse(await readFile(requestFile,'utf8'));
const control=new CoordinationControl(await CoordinationStore.open(root,repository,()=>{}));
try {
  const receipt=await control.execute(actor,command);
  if(mode==='lose-receipt') process.exit(74);
  process.stdout.write(JSON.stringify(receipt));
} finally { await control.close(); }
