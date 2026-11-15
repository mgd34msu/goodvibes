import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPreparationLockPath } from '../../../scripts/build-preparation-lock.ts';
import { runWorkspaceToolchain } from '../../../scripts/run-toolchain.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

test('an interrupted build leaves no grandchild running when its lock is released', async () => {
  const root = makeOwnedTempDir('daemon-toolchain-interrupt');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '1.2.3' }));
  const engine = join(root, 'node_modules/@goodvibes-jev/engine');
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' }, bin: { 'goodvibes-build-binaries': './fake.ts', 'goodvibes-post-build-smoke': './fake.ts' } }));
  // The fake build starts a grandchild that ignores SIGTERM and records its pid.
  writeFileSync(join(engine, 'fake.ts'), `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    writeFileSync('grandchild.pid', String(grandchild.pid));
    setInterval(() => {}, 1000);
  `);
  const building = runWorkspaceToolchain(root, 'build', []);
  const outcome = building.then(() => 'finished' as const, (error: unknown) => error);
  const pidFile = join(root, 'grandchild.pid');
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') await new Promise<void>((resolve) => setImmediate(resolve));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  process.emit('SIGTERM');
  const result = await outcome;
  expect(result).toBeInstanceOf(Error);
  expect(existsSync(buildPreparationLockPath(root))).toBe(false);
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  expect(alive).toBe(false);
});
