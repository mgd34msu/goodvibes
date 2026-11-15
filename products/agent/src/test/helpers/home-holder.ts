/**
 * A separate process that holds a surface home's claim, for tests that need a
 * live foreign owner. The claim is a kernel lock, so only a real process can
 * hold it; the returned child keeps it until it is killed.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const BOOTSTRAP_MODULE = Bun.resolveSync('@goodvibes-jev/engine/platform/platform/runtime/bootstrap', import.meta.dir);

const HOLD_SCRIPT = `
  const { claimSurfaceHome } = await import(process.argv[1]);
  claimSurfaceHome({ homeDirectory: process.argv[2], surfaceRoot: process.argv[3] });
  console.log('acquired');
  setInterval(() => {}, 1000);
`;

/** Start a process that claims `<home>/.goodvibes/<surfaceRoot>` and resolve once it holds it. */
export async function holdHomeInChildProcess(home: string, surfaceRoot: string): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', HOLD_SCRIPT, BOOTSTRAP_MODULE, home, surfaceRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (typeof child.pid !== 'number') throw new Error('could not start a home holder process');
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
      if (output.includes('acquired')) resolve();
    });
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString('utf-8'); });
    child.once('exit', (code) => reject(new Error(`the home holder exited (${code}) before claiming: ${errors.trim()}`)));
    child.once('error', reject);
  });
  return child as ChildProcess & { pid: number };
}
