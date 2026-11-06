import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('version-sync', () => {
test('SDK baked version stays aligned with the engine package version', () => {
  // The engine manifest (packages/engine/package.json) is what version.ts reads.
  const rootPackage = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const versionSource = readFileSync(
    resolve(ROOT, 'sdk', 'src', 'platform', 'version.ts'),
    'utf8',
  );
  const match = versionSource.match(/\bversion\s*=\s*['"](\d+\.\d+\.\d+[^'"]*)['"]/);

  expect(match).not.toBeNull();
  expect(match?.[1]).toBe(rootPackage.version);
});
test('daemon manifest and compiled fallback use the monorepo release version', () => {
  const repo = resolve(ROOT, '../..');
  const rootVersion: unknown = (JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as { version?: unknown }).version;
  if (typeof rootVersion !== 'string') throw new Error('The monorepo release owner must declare a version string.');
  const daemonVersion: unknown = (JSON.parse(readFileSync(resolve(repo, 'products/daemon/package.json'), 'utf8')) as { version?: unknown }).version;
  const source = readFileSync(resolve(repo, 'products/daemon/src/version.ts'), 'utf8');
  expect(daemonVersion).toBe(rootVersion);
  expect(source.match(/^let _version = '([^']+)';$/m)?.[1]).toBe(rootVersion);
});
for (const product of ['tui', 'agent']) {
  test(`${product} manifest and compiled fallback use the monorepo release identity`, () => {
    const repo = resolve(ROOT, '../..');
    const root = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as { version: string };
    const manifest = JSON.parse(readFileSync(resolve(repo, `products/${product}/package.json`), 'utf8')) as { name: string; version: string };
    const source = readFileSync(resolve(repo, `products/${product}/src/version.ts`), 'utf8');
    expect(manifest.name).toBe(`@goodvibes-jev/${product}`);
    expect(manifest.version).toBe(root.version);
    expect(source.match(/^let _version = '([^']+)';$/m)?.[1]).toBe(root.version);
    expect(source).toContain(`readProductVersion(import.meta.dir, '${manifest.name}', _version)`);
  });
}
});
