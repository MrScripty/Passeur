import { readFile } from 'node:fs/promises';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../../.passeur-core/src/core/repository-runtime.js';
import { runRepositoryService } from '../../../.passeur-core/src/service/server.js';
import { RuntimeIdentitySchema } from '../../../.passeur-core/src/contracts/runtime.js';
import { diagnosticInfo } from '../../../.passeur-core/src/core/errors.js';
// Test-owned binding file contains no token; actual service election and TaskStore run unchanged.
try {
  const intent=JSON.parse(await readFile(process.argv[2],'utf8'));
  const identity=RuntimeIdentitySchema.parse({package_version:'fixture',build_id:'elected-coordination-fixture',mode:'development',
    node_version:process.version,node_executable:process.execPath,pid:process.pid,started_at:new Date().toISOString()});
  const binding=await resolveRepositoryBinding(intent,{},new AbortController().signal);
  await runRepositoryService(new RepositoryRuntime(intent,identity,{},{}),binding,identity);
} catch(error) { console.error(JSON.stringify(diagnosticInfo(error))); process.exitCode=1; }
