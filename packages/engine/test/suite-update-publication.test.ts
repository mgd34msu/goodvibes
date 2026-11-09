import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySuiteUpdate, assertSuiteUpdateCurrent } from '../platform/src/platform/runtime/suite-update.js';
import { suiteReleaseFixture } from './_helpers/suite-release-fixture.js';

test('a completed native suite result retains its original outputs after ordinary claim cleanup', async () => {
  const f = suiteReleaseFixture();
  try {
    const result = await applySuiteUpdate(f.options);
    expect(() => assertSuiteUpdateCurrent(result)).not.toThrow();
    expect(() => assertSuiteUpdateCurrent({ ...result })).toThrow('publication is unavailable');
    writeFileSync(join(f.driver, 'new-foreign-file'), 'Not part of the publication');
    expect(() => assertSuiteUpdateCurrent(result)).toThrow();
  } finally { f.cleanup(); }
});

test('same-byte program replacement cannot inherit an earlier suite result', async () => {
  const f = suiteReleaseFixture();
  try {
    const result = await applySuiteUpdate(f.options);
    const { readFileSync } = await import('node:fs');
    const { writeFileAtomic } = await import('../platform/src/platform/utils/atomic-json-store.js');
    const program = join(f.root, 'goodvibes'); writeFileAtomic(program, readFileSync(program), { mode: 0o755 });
    expect(() => assertSuiteUpdateCurrent(result)).toThrow();
  } finally { f.cleanup(); }
});
