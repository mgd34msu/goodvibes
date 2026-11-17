/**
 * Every published import path resolves. Each entry of the engine's committed
 * package.json exports map is imported through the package NAME, so Bun
 * applies the real exports map exactly as a consumer install would: a subpath
 * missing from the manifest, or one whose target moved, fails here even though
 * a source file exists on disk. The built targets (`import`, `types`) must be
 * the built counterparts of the source target, so a consumer of the published
 * package loads the same module the workspace does.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE = join(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')) as {
  readonly name: string;
  readonly exports: Record<string, string | Record<string, string>>;
};
const entries = Object.entries(manifest.exports);
const modules = entries.filter((entry): entry is [string, Record<string, string>] => typeof entry[1] === 'object');

/** The built file a source target compiles to: `src/` becomes `dist/`, `.ts` becomes `.js` or `.d.ts`. */
function built(source: string, extension: '.js' | '.d.ts'): string {
  return source.replace('/src/', '/dist/').replace(/(\.d)?\.tsx?$/, extension);
}

describe('engine exports map', () => {
  test('the map is not empty, so the checks below read real entries', () => {
    expect(modules.length).toBeGreaterThan(100);
  });

  test('every source target exists and every built target is its counterpart', () => {
    const wrong: string[] = [];
    for (const [subpath, target] of entries) {
      if (typeof target === 'string') {
        if (!existsSync(join(ENGINE, target))) wrong.push(`${subpath}: ${target} does not exist`);
        continue;
      }
      if (!target.bun || !existsSync(join(ENGINE, target.bun))) { wrong.push(`${subpath}: source target ${String(target.bun)} does not exist`); continue; }
      if (target.types !== built(target.bun, '.d.ts')) wrong.push(`${subpath}: types ${target.types} is not the build of ${target.bun}`);
      // A types-only entry (a .d.ts source) has no runtime target.
      if (!target.bun.endsWith('.d.ts') && target.import !== built(target.bun, '.js')) wrong.push(`${subpath}: import ${target.import} is not the build of ${target.bun}`);
    }
    expect(wrong).toEqual([]);
  });

  test('every code subpath resolves and loads through the package name', async () => {
    const failed: string[] = [];
    for (const [subpath, target] of modules) {
      if (target.bun?.endsWith('.d.ts')) continue;
      try {
        await import(`${manifest.name}${subpath.slice(1)}`);
      } catch (error) {
        failed.push(`${subpath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failed).toEqual([]);
  });
});
