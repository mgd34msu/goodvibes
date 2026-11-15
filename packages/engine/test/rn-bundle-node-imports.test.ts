/**
 * Release gate: assert that companion entry point dist bundles do not
 * transitively pull in any `node:*` imports or `Bun.*` API calls.
 *
 * Metro and similar RN bundlers cannot handle `node:` protocol imports and
 * will hard-fail during release bundling. `Bun.*` API calls indicate the
 * agentic (Bun-only) surface has leaked into a companion bundle, this is a
 * hard architectural violation and must block release.
 *
 * This test enforces the companion bundle boundary.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIST = resolve(__dirname, '../platform/dist');

/**
 * Companion entry points that must be free of `node:*` imports and `Bun.*`
 * calls in the built output. These are the files Metro / Expo's bundler and
 * browser bundlers will trace from.
 */
const COMPANION_ENTRIES = [
  'react-native.js',
  'expo.js',
  'browser.js',
  'browser-homeassistant.js',
  'browser-knowledge.js',
  'web.js',
  'workers.js',
  // The /auth subpath is also consumed by RN/browser consumers for token helpers.
  'auth.js',
];

/**
 * Patterns that must NOT appear in companion dist files.
 * - node: imports fail Metro bundling hard.
 * - Bun.* calls indicate a Bun-only API leaked into the companion surface.
 */
const DISALLOWED: { pattern: RegExp; label: string }[] = [
  { pattern: /from ['"]node:/, label: 'node: import' },
  { pattern: /require\(['"]node:/, label: 'node: require' },
  { pattern: /\bBun\.\w+/, label: 'Bun.* API call (Bun-only surface leak)' },
];

/**
 * Relative specifiers a built JS file pulls in: `import ... from './x.js'`,
 * `export ... from './x.js'`, side-effect `import './x.js'` and dynamic
 * `import('./x.js')`. Bare package specifiers are not followed.
 */
const RELATIVE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every file reachable from `entry` through relative specifiers (entry included). */
export function reachableFiles(distRoot: string, entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(distRoot, entry)];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
      const target = resolve(dirname(file), m[1] as string);
      queue.push(target.endsWith('.js') ? target : `${target}.js`);
    }
  }
  return [...seen];
}

/** Violations as `<file>: <label>` across every file reachable from `entry`. */
export function findViolations(distRoot: string, entry: string): string[] {
  const out: string[] = [];
  for (const file of reachableFiles(distRoot, entry)) {
    const content = readFileSync(file, 'utf8');
    for (const { pattern, label } of DISALLOWED) {
      const match = content.match(pattern);
      if (match) out.push(`${file.slice(distRoot.length + 1)}: ${label} (${match[0]})`);
    }
  }
  return out;
}

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixtureDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-rn-dist-'));
  fixtureDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('Companion bundle guard walker', () => {
  test('flags a node: import in a module reached only through re-exports', () => {
    const dist = makeFixtureDist({
      'web.js': "export * from './client.js';\n",
      'client.js': "import { sign } from './client-auth/sign.js';\nexport { sign };\n",
      'client-auth/sign.js': "import fs from 'node:fs';\nexport const sign = () => fs;\n",
    });
    expect(findViolations(dist, 'web.js')).toEqual(['client-auth/sign.js: node: import (from \'node:)']);
  });

  test('flags Bun.* and require(node:) in reached files, and follows dynamic and side-effect imports', () => {
    const dist = makeFixtureDist({
      'a.js': "import './b.js';\nconst m = await import('./c.js');\n",
      'b.js': "export const x = Bun.file('x');\n",
      'c.js': "const fs = require('node:fs');\n",
    });
    const found = findViolations(dist, 'a.js');
    expect(found.some((v) => v.startsWith('b.js: Bun.*'))).toBe(true);
    expect(found.some((v) => v.startsWith('c.js: node: require'))).toBe(true);
  });

  test('a clean graph (with a cycle and a node: import in an unreached file) has no violations', () => {
    const dist = makeFixtureDist({
      'a.js': "export * from './b.js';\n",
      'b.js': "export * from './a.js';\nexport const ok = 1;\n",
      'unreached.js': "import fs from 'node:fs';\n",
    });
    expect(findViolations(dist, 'a.js')).toEqual([]);
  });
});

describe('Companion bundle guard: no node: imports or Bun.* calls reachable from the entry', () => {
  for (const entry of COMPANION_ENTRIES) {
    test(`dist/${entry} and everything it imports is free of node: and Bun.*`, () => {
      // Fail loudly if dist was not built.
      expect(existsSync(resolve(PLATFORM_DIST, entry))).toBe(true);
      expect(findViolations(PLATFORM_DIST, entry)).toEqual([]);
    });
  }
});
