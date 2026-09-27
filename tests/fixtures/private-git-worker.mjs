import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const fixture = JSON.parse(process.argv[2]);
assert.equal(process.cwd(), fixture.workspace);
assert.equal(process.env.GIT_DIR, undefined);
assert.equal(readFileSync(join(fixture.workspace, '.git'), 'utf8').trim(),
  `gitdir: ${fixture.canonicalCommonDir}/${fixture.adminRelative}`);
for (const path of fixture.deniedFiles) {
  assert.equal(existsSync(path), false, `protected path visible: ${path}`);
  assert.equal(existsSync(`/proc/self/root${path}`), false, `proc route visible: ${path}`);
}
for (const path of fixture.symlinkFiles) assert.equal(existsSync(path), false, `symlink route visible: ${path}`);
for (const path of fixture.symlinkFiles) unlinkSync(join(path, '..'));
unlinkSync(new URL(import.meta.url));
const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
assert.equal(common.status, 0, common.stderr);
assert.equal(common.stdout.trim(), fixture.canonicalCommonDir);
const refs = spawnSync('git', ['for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
assert.equal(refs.status, 0, refs.stderr);
assert.equal(refs.stdout.trim(), fixture.branch);
const siblingObject = spawnSync('git', ['cat-file', '-e', `${fixture.siblingHead}^{commit}`], { encoding: 'utf8' });
assert.notEqual(siblingObject.status, 0, 'sibling object leaked into private Git');

await new Promise((resolve, reject) => {
  const socket = net.connect(fixture.hostPort, '127.0.0.1');
  const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('host listener was reachable')); });
  socket.once('error', () => { clearTimeout(timer); resolve(); });
});

writeFileSync('worker.txt', 'exact controlled private bytes\n');
for (const args of [
  ['add', 'worker.txt'],
  ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'private controlled work'],
]) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
assert.equal(head.status, 0, head.stderr);
const child = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(fixture.descendantReady)},'ready');setInterval(()=>{},1000)`], { stdio: 'ignore' });
child.once('error', (error) => { throw error; });
while (!existsSync(fixture.descendantReady)) await new Promise((resolve) => setTimeout(resolve, 10));
writeFileSync(fixture.workerReady, JSON.stringify({ head: head.stdout.trim() }));
const deadline = Date.now() + 60_000;
while (!existsSync(fixture.release)) {
  if (Date.now() > deadline) throw new Error('controlled worker release was not received');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
child.kill('SIGTERM');
await new Promise((resolve) => child.once('exit', resolve));
writeFileSync(fixture.workerStopped, 'stopped');
