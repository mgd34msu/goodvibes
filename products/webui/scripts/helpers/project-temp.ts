import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A scratch directory under os.tmpdir(): inside the run's temp directory when
 * the tests run through packages/engine/scripts/test.ts (it exports TMPDIR and
 * removes the directory afterwards). Deliberately self-contained, Playwright
 * imports this under Node, where the engine's source export is not available.
 */
export function makeProjectTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
