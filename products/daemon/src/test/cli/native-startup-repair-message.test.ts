import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_STARTUP_REPAIR_MESSAGE } from '../../cli/native-startup-repair.ts';

// The release scripts run under plain Node outside the build, so they carry their own copy of the sentence.
const scripts = join(import.meta.dir, '../../../../../scripts');

test.each(['accept-published-suite.mjs'])('%s recognises exactly the sentence the daemon prints', (name) => {
  expect(readFileSync(join(scripts, name), 'utf8')).toContain(`'${NATIVE_STARTUP_REPAIR_MESSAGE}'`);
});
