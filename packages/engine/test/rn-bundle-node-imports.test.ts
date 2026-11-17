/**
 * The companion entry points (React Native, Expo, browser, web, Workers and the
 * auth helpers) pull in no Node-only module and call no Bun API. Metro and the
 * browser bundlers fail hard on a Node built-in, and a `Bun.*` call means the
 * Bun-only agent surface leaked into a companion bundle.
 *
 * The check reads source, not built output, so it needs no build: from each
 * entry's source target in the engine exports map it follows every runtime
 * import (type-only imports are erased and are not followed), relative ones
 * and ones into the workspace packages through their exports maps, and looks
 * at each reached module's runtime code.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const ENGINE = join(import.meta.dir, '..');
const JUDGMENT = join(ENGINE, '..', 'judgment');

interface Manifest { readonly name: string; readonly exports: Record<string, string | Record<string, string>> }
const workspacePackages = [ENGINE, JUDGMENT].map((root) => ({ root, manifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest }));

/** The engine subpaths companion consumers import. */
const COMPANION_SUBPATHS = [
  './platform/react-native',
  './platform/expo',
  './platform/browser',
  './platform/browser/homeassistant',
  './platform/browser/knowledge',
  './platform/web',
  './platform/workers',
  './platform/auth',
];

const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** The source file a specifier names: relative to `from`, or a workspace package subpath through its exports map. */
function resolveSource(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(from), specifier);
    return [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
  }
  for (const { root, manifest } of workspacePackages) {
    if (specifier !== manifest.name && !specifier.startsWith(`${manifest.name}/`)) continue;
    const target = manifest.exports[`.${specifier.slice(manifest.name.length)}`];
    return typeof target === 'object' && target.bun ? join(root, target.bun) : undefined;
  }
  return undefined;
}

/** Every Node built-in import, `bun` import, `Bun.*` use or unresolvable relative import reachable from `entry`. */
function violations(entry: string): { readonly files: number; readonly found: string[] } {
  const seen = new Set<string>();
  const queue = [entry];
  const found: string[] = [];
  const label = (file: string) => file.slice(join(ENGINE, '..').length + 1);
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const { path } of transpiler.scanImports(code)) {
      if (isBuiltin(path) || path === 'bun' || path.startsWith('bun:')) { found.push(`${label(file)}: imports ${path}`); continue; }
      const next = resolveSource(file, path);
      if (next) queue.push(next);
      else if (path.startsWith('.')) found.push(`${label(file)}: ${path} does not resolve`);
    }
    const bunCall = /\bBun\.\w+/.exec(transpiler.transformSync(code));
    if (bunCall) found.push(`${label(file)}: uses ${bunCall[0]}`);
  }
  return { files: seen.size, found };
}

describe('companion entry points', () => {
  test.each(COMPANION_SUBPATHS)('%s reaches no Node built-in and no Bun API', (subpath) => {
    const target = workspacePackages[0]!.manifest.exports[subpath];
    expect(typeof target === 'object' && typeof target.bun === 'string').toBe(true);
    const { found } = violations(join(ENGINE, (target as Record<string, string>).bun!));
    expect(found).toEqual([]);
  });

  test('the walk follows imports across modules and packages', () => {
    // A walk that stopped at the entry would pass every check above while reading one file.
    expect(violations(join(ENGINE, 'platform/src/react-native.ts')).files).toBeGreaterThan(50);
  });
});
