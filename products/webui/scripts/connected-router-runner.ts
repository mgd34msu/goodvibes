/** Explicit cross-product acceptance; never attaches to an existing daemon. */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRootFor, sweepStaleRunRoots } from './test-temp-root';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
sweepStaleRunRoots(project);
// A fresh child must not inherit real provider keys, daemon credentials, HOME,
// proxies, host selection or product startup options from the developer shell.
const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
for (const name of ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', 'GOODVIBES_WEBUI_CONNECTED_BUNDLE', 'GOODVIBES_WEBUI_CONNECTED_OUTPUT']) {
  const value = process.env[name]; if (value) env[name] = value;
}
const child = Bun.spawn([process.execPath, join(project, 'scripts/connected-router-smoke.ts')], {
  cwd: project, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
});
let interrupted = false;
const stop = () => { interrupted = true; child.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const ceiling = setTimeout(stop, 300_000);
try {
  const code = await child.exited;
  // The child has drained its daemon/browser before exiting; cleanup from this
  // original parent also follows late process-exit log flushes.
  const root = runRootFor(child.pid, project);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  process.exitCode = interrupted ? 1 : code;
} finally {
  clearTimeout(ceiling); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
