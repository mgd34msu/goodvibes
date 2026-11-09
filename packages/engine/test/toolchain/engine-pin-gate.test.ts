import { describe, expect, test } from 'bun:test';
import { runEnginePinGate, readEnginePin, resolveEnginePinConfig } from '@goodvibes-jev/engine/toolchain';
import { fakeFs } from './_helpers.ts';

// The default engine package (DEFAULT_ENGINE_PACKAGE); a repo depends on it by
// exact version or through the monorepo workspace.
const engine = '@goodvibes-jev/engine';

function baseFiles(pin: string, installed = pin): Record<string, string> {
  return {
    'package.json': JSON.stringify({ dependencies: { [engine]: pin } }),
    'bun.lock': `resolved "${engine}@${installed}"`,
    [`node_modules/${engine}/package.json`]: JSON.stringify({ version: installed, exports: { '.': {}, './errors': {} } }),
    'src/index.ts': `import { thing } from '${engine}';`,
  };
}

describe('engine-pin-gate', () => {
  test('all gates pass on a clean dependencies pin', () => {
    const results = runEnginePinGate(fakeFs(baseFiles('1.10.1')), { pinSource: 'dependencies' });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.id)).toContain('lockfile-resolves-pin');
  });

  test('flags a non-exact pin', () => {
    const results = runEnginePinGate(fakeFs(baseFiles('^1.10.1')), { pinSource: 'dependencies' });
    const gate = results.find((r) => r.id === 'engine-pin-exact-semver');
    expect(gate?.ok).toBe(false);
  });

  test('flags a lockfile that lagged the pin bump', () => {
    const files = baseFiles('1.10.1');
    files['bun.lock'] = `resolved "${engine}@1.10.0"`;
    const results = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'lockfile-resolves-pin')?.ok).toBe(false);
  });

  test('flags installed version drift from the pin', () => {
    const files = baseFiles('1.10.1', '1.10.0');
    files['bun.lock'] = `resolved "${engine}@1.10.1"`;
    const results = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'installed-matches-pin')?.ok).toBe(false);
  });

  test('flags a dev-link overlay marker', () => {
    const files = baseFiles('1.10.1');
    files[`node_modules/${engine}/.local-engine-overlay.json`] = '{}';
    const results = runEnginePinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'local-engine-overlay-absent')?.ok).toBe(false);
  });

  test('flags a non-npm engine import', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import { thing } from '../../goodvibes/src/index.ts';`;
    const results = runEnginePinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(false);
  });

  test('flags a relative import into the engine source', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import { thing } from '../../packages/engine/platform/src/index.ts';`;
    const results = runEnginePinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(false);
  });

  test('a relative import is resolved against its file, so a sibling engine package is caught', () => {
    const files = baseFiles('1.10.1');
    files['src/lib/deep.ts'] = `import { thing } from '../../../engine/engine/src/index.ts';`;
    const results = runEnginePinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(false);
  });

  test('a directory with a dot in its name is still walked', () => {
    const files = baseFiles('1.10.1');
    files['src/v1.2/entry.ts'] = `import { thing } from '../../packages/engine/platform/src/index.ts';`;
    const results = runEnginePinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(false);
  });

  test('a relative import that stays inside the consumer passes', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import { local } from './engine/local.ts';`;
    const results = runEnginePinGate(fakeFs(files), {});
    expect(results.find((r) => r.id === 'npm-specifier-only-imports')?.ok).toBe(true);
  });

  test('WebUI local client imports remain consumer source at every actual nesting level', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = "import { client } from './lib/goodvibes';";
    files['src/lib/state.ts'] = "import { client } from './goodvibes';";
    files['src/lib/nested/state.ts'] = "import { client } from '../goodvibes';";
    files['src/views/chat.ts'] = "import { client } from '../lib/goodvibes';";
    files['src/components/settings/dialog/editor.ts'] = "import { client } from '../../../lib/goodvibes';";
    files['scripts/live.ts'] = "import { client } from '../src/lib/goodvibes';";
    files['e2e/support/client.ts'] = "import { client } from '../../src/lib/goodvibes';";
    const results = runEnginePinGate(fakeFs(files), { sourceRoots: ['src', 'scripts', 'e2e'], enforceExportsMap: true });
    expect(results.find(result => result.id === 'npm-specifier-only-imports')?.ok).toBe(true);
    expect(results.find(result => result.id === 'exports-map-only-imports')?.ok).toBe(true);
  });

  test('escaping into a historical checkout still refuses direct source imports', () => {
    for (const specifier of ['../../goodvibes/src/index.ts', '../../goodvibes-platform/src/index.ts', '../../shared/goodvibes/src/index.ts']) {
      const files = baseFiles('1.10.1');
      files['src/index.ts'] = `import { thing } from '${specifier}';`;
      const gate = runEnginePinGate(fakeFs(files), {}).find(result => result.id === 'npm-specifier-only-imports');
      expect(gate?.ok).toBe(false); expect(gate?.detail).toContain(specifier);
    }
  });

  test('reads the pin from devDependencies when configured (agent variant)', () => {
    const fs = fakeFs({ 'package.json': JSON.stringify({ devDependencies: { [engine]: '1.10.1' } }) });
    expect(readEnginePin(fs, resolveEnginePinConfig({ pinSource: 'devDependencies' }))).toBe('1.10.1');
  });

  test('exports-map enforcement flags a deep import (webui variant)', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import x from '${engine}/dist/internal.js';`;
    const results = runEnginePinGate(fakeFs(files), { enforceExportsMap: true });
    expect(results.find((r) => r.id === 'exports-map-only-imports')?.ok).toBe(false);
  });

  test('exports-map enforcement passes a published subpath', () => {
    const files = baseFiles('1.10.1');
    files['src/index.ts'] = `import x from '${engine}/errors';`;
    const results = runEnginePinGate(fakeFs(files), { enforceExportsMap: true });
    expect(results.find((r) => r.id === 'exports-map-only-imports')?.ok).toBe(true);
  });
});

describe('engine-pin-gate: a workspace dependency on the engine', () => {
  function workspaceFiles(): Record<string, string> {
    return {
      'package.json': JSON.stringify({ dependencies: { [engine]: 'workspace:*' } }),
      'bun.lock': `"${engine}": ["${engine}@workspace:packages/engine"]`,
      [`node_modules/${engine}/package.json`]: JSON.stringify({ version: '0.0.0', exports: { './errors': {} } }),
      'src/index.ts': `import { thing } from '${engine}/errors';`,
    };
  }

  test('is a valid pin when the workspace link is installed and locked', () => {
    const results = runEnginePinGate(fakeFs(workspaceFiles()), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'engine-pin-exact-semver')?.ok).toBe(true);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.id)).toContain('lockfile-resolves-pin');
  });

  test('flags a workspace pin with no installed link', () => {
    const files = workspaceFiles();
    delete files[`node_modules/${engine}/package.json`];
    const results = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'installed-matches-pin')?.ok).toBe(false);
  });

  test('flags a lockfile with no workspace entry for the engine', () => {
    const files = workspaceFiles();
    files['bun.lock'] = `resolved "${engine}@0.0.0"`;
    const results = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' });
    expect(results.find((r) => r.id === 'lockfile-resolves-pin')?.ok).toBe(false);
  });
});

// Historical filenames are blocking saved evidence, never current export aliases.
for (const suffix of ['.local-engine-overlay.json', '.local-sdk-overlay.json', 'sdk/.local-sdk-overlay.json', 'platform/.local-sdk-overlay.json']) {
  test(`the package-root gate refuses original overlay evidence at ${suffix}`, () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ dependencies: { '@goodvibes-jev/engine': '3.1.2' } }),
      'bun.lock': '@goodvibes-jev/engine@3.1.2',
      'node_modules/@goodvibes-jev/engine/package.json': JSON.stringify({ name: '@goodvibes-jev/engine', version: '3.1.2' }),
      [`node_modules/@goodvibes-jev/engine/${suffix}`]: '{}',
    };
    const results = runEnginePinGate(fakeFs(files), undefined);
    expect(results.find(result => result.id === 'local-engine-overlay-absent')?.ok).toBe(false);
  });
}

test('a package import subpath cannot masquerade as a dependency root', () => {
  expect(() => resolveEnginePinConfig({ enginePackage: '@goodvibes-jev/engine/platform' })).toThrow('package root');
  expect(resolveEnginePinConfig(undefined).enginePackage).toBe('@goodvibes-jev/engine');
});


test('a retained failed-reinstall receipt blocks release even while the installed engine is absent', () => {
  const files = baseFiles('3.1.2');
  delete files[`node_modules/${engine}/package.json`];
  files['.engine-overlay-restore.json'] = JSON.stringify({ schema: 1, overlaidPackages: ['engine'] });
  const results = runEnginePinGate(fakeFs(files), {});
  expect(results.find(result => result.id === 'local-engine-overlay-absent')?.ok).toBe(false);
});
