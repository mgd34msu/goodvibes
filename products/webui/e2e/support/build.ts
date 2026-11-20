/**
 * Playwright globalSetup: build the web UI once (the same production build the
 * release ships), into the folder every journey's daemon serves it from.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
/** Where the build lands; GOODVIBES_E2E_DIST moves it so two local runs do not empty each other's build. */
export const E2E_DIST_DIR = resolve(PROJECT, process.env.GOODVIBES_E2E_DIST ?? 'e2e/.artifacts/e2e-dist');

export default function buildWebUi(): void {
  // The committed snapshots of the engine's settings data the build reads, as the product build checks them.
  const checked = spawnSync('bun', ['run', 'generated:check'], { cwd: PROJECT, stdio: 'inherit' });
  if (checked.status !== 0) throw new Error(`generated:check failed (exit ${checked.status})`);
  const built = spawnSync('bunx', ['vite', 'build', '--outDir', E2E_DIST_DIR, '--emptyOutDir'], { cwd: PROJECT, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`the web UI build failed (exit ${built.status})`);
}
