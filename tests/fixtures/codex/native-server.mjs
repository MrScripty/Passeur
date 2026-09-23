// Controlled protocol peer, never loaded by production. Modes expose real pipe/process failure paths.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const mode = process.argv[2] ?? 'echo';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === 'no-input') setInterval(() => undefined, 1000);
else {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const frame = JSON.parse(line);
    if (!frame.method || frame.id === undefined) return;
    if (mode === 'malformed') return process.stdout.write('{broken\n');
    if (mode === 'bad-utf8') return process.stdout.write(Buffer.from([0xff, 10]));
    if (mode === 'oversize') return process.stdout.write(`${'x'.repeat(1_048_577)}\n`);
    if (mode === 'unmatched') return send({ id: 'absent', result: null });
    if (mode === 'timestamp-notification') send({ method: 'remoteControl/status/changed', params: { status: 'idle' }, emittedAtMs: Date.now() });
    if (mode === 'approval' && frame.method === 'start') {
      send({ id: 91, method: 'permission', params: { operation: 'one' } });
      send({ id: frame.id, result: 'started' });
      return;
    }
    if (mode === 'duplicate') {
      send({ id: 91, method: 'permission', params: {} });
      send({ id: 91, method: 'permission', params: {} });
      return;
    }
    if (mode === 'orphan') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.unref();
      send({ id: frame.id, result: { descendant: child.pid } });
      return;
    }
    const response = Buffer.from(`${JSON.stringify({ id: frame.id, result: frame.params })}\n`);
    if (mode === 'split') {
      const unicode = response.indexOf(Buffer.from('🌲'));
      const cut = unicode < 0 ? 3 : unicode + 2;
      process.stdout.write(response.subarray(0, cut));
      setImmediate(() => process.stdout.write(response.subarray(cut)));
    } else send({ id: frame.id, result: frame.params });
  });
  lines.on('close', () => process.exit(0));
}
