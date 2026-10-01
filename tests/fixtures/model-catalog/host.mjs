#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const root = dirname(process.argv[1]);
const trace = value => appendFileSync(join(root, 'trace.jsonl'), JSON.stringify(value) + '\n');
trace({ event: 'started', pid: process.pid, args: process.argv.slice(2) });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line); trace({ method: request.method, params: request.params });
  if (!request.id) return;
  const config = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
  if (config.hang === request.method) return;
  const result = request.method === 'initialize' ? { schema: { fingerprint: 'fixture' } }
    : request.method === 'model/list' ? config.catalog : undefined;
  const error = request.method !== 'initialize' && request.method !== 'model/list'
    ? { code: -32601, message: 'Unexpected inference/session request' }
    : config.error && request.method === 'model/list' ? { code: -32000, message: config.error } : undefined;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\n');
});
lines.on('close', () => { trace({ event: 'closed' }); });
