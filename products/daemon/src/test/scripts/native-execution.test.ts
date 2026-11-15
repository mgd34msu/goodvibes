import { join } from 'node:path';

// These files are plain Node sources written against node:test, which the repository runner maps
// onto its own reporter. Importing them registers every case here, so each one reports on its own
// and no separate `node` binary, stderr text or outer time budget is involved.
const scripts = join(import.meta.dir, '../../../scripts');
for (const name of [
  'native-execution-artifact.test.mjs',
  'native-execution-process.test.mjs',
  'native-startup-liveness.test.mjs',
  'local-payload-comparison.test.mjs',
]) await import(join(scripts, name));
