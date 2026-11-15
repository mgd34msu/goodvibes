/**
 * sqlite-vec-resolver.test.ts
 *
 * The resolver that finds the sqlite-vec native extension: empty in a source
 * checkout (the npm package loads it), and the co-located
 * `<execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>` inside a compiled binary,
 * which is recognised by its `/$bunfs/` module URL.
 */

import { describe, expect, test } from 'bun:test';
import { resolveSqliteVecPath } from '../platform/src/platform/state/memory-vector-store.js';

const BUNDLED_URL = 'file:///$bunfs/root/goodvibes';

describe('resolveSqliteVecPath: source checkout', () => {
  test('returns empty string when not running inside $bunfs', () => {
    expect(resolveSqliteVecPath()).toBe('');
  });

  test('a $bunfs marker inside an ordinary path is not a compiled binary', () => {
    expect(resolveSqliteVecPath({ moduleUrl: 'file:///home/dev/$bunfs/project/index.ts' })).toBe('');
  });
});

describe('resolveSqliteVecPath: compiled binary', () => {
  test.each([
    ['linux', 'x64', '/usr/local/bin/goodvibes', '/usr/local/bin/lib/sqlite-vec-linux-x64/vec0.so'],
    ['linux', 'arm64', '/opt/gv/goodvibes', '/opt/gv/lib/sqlite-vec-linux-arm64/vec0.so'],
    ['darwin', 'arm64', '/Applications/goodvibes/goodvibes', '/Applications/goodvibes/lib/sqlite-vec-darwin-arm64/vec0.dylib'],
    ['win32', 'x64', '/gv/goodvibes.exe', '/gv/lib/sqlite-vec-windows-x64/vec0.dll'],
  ] as const)('%s %s resolves next to the executable', (platform, arch, execPath, expected) => {
    expect(resolveSqliteVecPath({ moduleUrl: BUNDLED_URL, execPath, platform, arch })).toBe(expected);
  });
});
