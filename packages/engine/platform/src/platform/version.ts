import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let version = '3.2.0';
try {
  // The engine manifest: packages/engine/package.json, three levels above platform/src/platform (and platform/dist/platform).
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf-8'));
  version = pkg.version ?? version;
} catch {
  // Keep the baked value when package.json is not available.
}

export const VERSION = version;
