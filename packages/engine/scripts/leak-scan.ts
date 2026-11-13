/**
 * Runs the full test suite with the timer-leak detector preloaded.
 *
 * The suite runs every test file in ONE bun process, so a poller a test forgets
 * to stop keeps firing inside every later test file. This script is how that
 * class of bug is measured: it reports the handles still live when the run ends
 * and attributes each to the test file that created it.
 *
 *   bun scripts/leak-scan.ts                    # whole suite
 *   bun scripts/leak-scan.ts test/foo.test.ts   # one file
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultTestArgs } from './test-discovery.ts';
import { runBunTest } from './test.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const testArgs = args.length > 0 ? args : defaultTestArgs(ENGINE_ROOT);
const reportPath = process.env.GOODVIBES_LEAK_REPORT ?? resolve(ENGINE_ROOT, '.tmp/leak-report.json');

const exitCode = await runBunTest({
  args: ['--preload', './test/_helpers/leak-detector.ts', ...testArgs],
  env: { ...process.env, GOODVIBES_LEAK_DETECT: '1', GOODVIBES_LEAK_REPORT: reportPath },
});
console.log(`\nleak report written to ${reportPath}`);
if (exitCode !== 0) console.log(`(suite exited ${exitCode}, leak data above is still valid)`);
