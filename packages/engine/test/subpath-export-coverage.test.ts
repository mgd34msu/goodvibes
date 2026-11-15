/**
 * subpath-export-coverage.test.ts, every public platform module is reachable.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `scripts/check-subpath-api-surface.ts` iterates the package manifest's
 * `exports` map and validates the surface of each entry it finds. That makes it
 * excellent at catching a CHANGE to a declared subpath and structurally
 * incapable of catching a MISSING one: a module with no entry is not in the map,
 * so the check never looks at it and every gate stays green.
 *
 * The failure mode is invisible in the worst possible way. The source compiles,
 * the module's own tests pass, `dist/` contains the built files, api-extractor
 * is happy, and the whole suite is green, while
 * `import … from '@goodvibes-jev/engine/platform/platform/<name>'` fails resolution for
 * every consumer. The capability is built, tested, shipped, and unreachable.
 *
 * It is also exactly the class the owner's standing rule is about: everything
 * gets wired, nothing left behind, nothing unconsumed. A capability that cannot
 * be imported is not shipped.
 *
 * ── Why an allowlist rather than "export everything" ──────────────────────
 *
 * Some platform modules are genuinely daemon-internal, and publishing them would
 * widen the public API surface, and its compatibility obligations, by
 * accident. So the rule is: every `src/platform/<name>/index.ts` is either in the
 * exports map or named in `INTENTIONALLY_INTERNAL` (scripts/engine-package-lists.ts),
 * the one list the `exports:check` gate reads too. Adding a module and
 * forgetting both is what fails.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INTENTIONALLY_INTERNAL } from '../scripts/engine-package-lists.ts';
import { platformExportsMap } from './_helpers/platform-exports.js';

const PACKAGE_DIR = join(import.meta.dir, '..', 'platform');
const PLATFORM_DIR = join(PACKAGE_DIR, 'src', 'platform');

function platformModulesWithIndex(): string[] {
  return readdirSync(PLATFORM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(PLATFORM_DIR, name, 'index.ts')))
    .sort();
}

const ENGINE_DIR = join(import.meta.dir, '..');
const exportsMap = platformExportsMap;

describe('every public platform module has a subpath export', () => {
  test('no module is silently unreachable', () => {
    const exported = new Set(Object.keys(exportsMap()));
    const internal = new Set(Object.keys(INTENTIONALLY_INTERNAL));
    const unreachable = platformModulesWithIndex()
      .filter((name) => !exported.has(`./platform/${name}`) && !internal.has(name));

    expect(
      unreachable,
      `these platform modules have an index.ts but no "./platform/<name>" entry in `
      + `the engine package.json's ./platform exports, so consumers cannot import them: ${unreachable.join(', ')}. `
      + 'Add the subpath, or add the module to INTENTIONALLY_INTERNAL in scripts/engine-package-lists.ts if it is deliberately private.',
    ).toEqual([]);
  });

  test('the internal list has no stale entries', () => {
    // A name left here after the module is deleted or published reads as a
    // decision nobody made.
    const present = new Set(platformModulesWithIndex());
    const exported = new Set(Object.keys(exportsMap()));
    const stale = Object.keys(INTENTIONALLY_INTERNAL).filter(
      (name) => !present.has(name) || exported.has(`./platform/${name}`),
    );
    expect(stale, `no longer internal or no longer present: ${stale.join(', ')}`).toEqual([]);
  });

  test('every declared subpath points at a file that exists in the package', () => {
    // The manifest can name a module path that is not there, which fails at
    // import time and not before.
    // Each entry is a string (a JSON asset) or conditions naming the source
    // module and, once built, its dist output; the source must always exist.
    const broken: string[] = [];
    for (const [subpath, entry] of Object.entries(exportsMap())) {
      const target = typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['bun'] : undefined;
      if (typeof target !== 'string') {
        broken.push(`${subpath} -> (no source target)`);
        continue;
      }
      if (!existsSync(join(ENGINE_DIR, target))) broken.push(`${subpath} -> ${target}`);
    }
    expect(broken, `exports entries pointing at missing modules: ${broken.join(', ')}`).toEqual([]);
  });

  test.each(['payments', 'ci-watch'])('the %s capability specifically is reachable', (name) => {
    // Shipped modules, pinned by name so a later manifest edit
    // that drops it fails loudly rather than silently unshipping the feature.
    expect(Object.keys(exportsMap())).toContain(`./platform/${name}`);
  });
});
