/**
 * Runs test files with the timer-leak detector preloaded.
 *
 * An ordinary run gives each test file its own process, which hides a poller a
 * test forgets to stop. This script runs every file in ONE bun process on
 * purpose, so such a poller keeps firing inside every later file: it reports the
 * handles still live when the run ends and attributes each to the test file
 * that created it. Isolation and the per-test limit are the runner's.
 *
 *   bun scripts/leak-scan.ts                    # every engine default-suite file
 *   bun scripts/leak-scan.ts test/foo.test.ts   # one file
 *   bun scripts/leak-scan.ts --cwd ../../products/tui --preload ./src/test/_helpers/leak-detector.ts [files]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverTestFiles, runInOneProcess, selectTestFiles } from './test.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let cwd = ENGINE_ROOT;
let preload = './test/_helpers/leak-detector.ts';
const paths: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === '--cwd') cwd = resolve(ENGINE_ROOT, argv[++i] ?? '.');
  else if (arg === '--preload') preload = argv[++i] ?? preload;
  else paths.push(arg);
}

const files = selectTestFiles(discoverTestFiles(), { paths: paths.length > 0 ? paths : [cwd], kinds: new Set(['default']), bases: [cwd, process.cwd()] })
  .filter((file) => file.cwd === cwd);
const reportPath = process.env.GOODVIBES_LEAK_REPORT ?? resolve(cwd, '.test-tmp/leak-report.json');
console.log(`leak-scan: ${files.length} test file(s)`);

const exitCode = await runInOneProcess(cwd, files, preload, { ...process.env, GOODVIBES_LEAK_DETECT: '1', GOODVIBES_LEAK_REPORT: reportPath });
console.log(`\nleak report written to ${reportPath}`);
if (exitCode !== 0) console.log(`(suite exited ${exitCode}, leak data above is still valid)`);
// A failing suite is a failing scan; the report above is still written.
process.exitCode = exitCode;
