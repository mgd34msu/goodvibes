/**
 * The platform's subpaths, keyed as `./platform/<name>`: the engine manifest's
 * `./platform/*` exports with the leading `./platform` segment removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_DIR = join(import.meta.dir, '..', '..');

export function platformExportsMap(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return Object.fromEntries(
    Object.entries(manifest.exports ?? {})
      .filter(([key]) => key.startsWith('./platform/'))
      .map(([key, value]) => [`.${key.slice('./platform'.length)}`, value]),
  );
}
