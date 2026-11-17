/**
 * Runs every test file in ONE bun process with the timer-leak detector
 * preloaded, and reports the handles still live when the run ends.
 *
 * This is deliberately NOT how the repository's runner runs the suite. That
 * runner gives each file its own process, which is the right default, it is
 * what keeps a poller one test forgot from firing inside an unrelated later
 * file. But process isolation also HIDES those pollers: the process exits and
 * takes them with it, so nothing is ever measured. Collapsing the suite into a
 * single process for this scan is what makes a leak observable at all.
 *
 *   bun scripts/leak-scan.ts                       # every test file
 *   bun scripts/leak-scan.ts src/test/foo.test.ts  # one file
 *
 * The engine's leak scan does the work, from this package's directory with
 * this package's detector: it keeps the runner's isolated home, temp directory,
 * network block and per-test limit.
 */
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_ROOT = resolve(ROOT, '../../packages/engine');
const result = spawnSync(
  process.execPath,
  [
    resolve(ENGINE_ROOT, 'scripts/leak-scan.ts'),
    '--cwd', relative(ENGINE_ROOT, ROOT),
    '--preload', './src/test/_helpers/leak-detector.ts',
    ...process.argv.slice(2),
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
// A failing suite is a failing scan; the report is still written.
process.exitCode = result.status ?? 1;
