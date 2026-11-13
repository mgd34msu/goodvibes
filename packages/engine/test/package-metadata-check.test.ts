/** Exercise the actual CLI against disposable package fixtures, without a model or credentials. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ENGINE_ROOT = resolve(import.meta.dir, '..');
const SCRIPTS = [
  'package-metadata-check.ts', 'docs-completeness-check.ts',
  'export-conditions.ts', 'release-shared.ts', 'workspace-lock.ts',
];

let root: string;

function write(path: string, value: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

function editManifest(edit: (manifest: Record<string, unknown>) => void): void {
  const path = join(root, 'packages/engine/package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

function run(script = 'package-metadata-check.ts', env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--preload', join(root, 'offline.ts'), join(root, 'packages/engine/scripts', script)],
    cwd: root,
    // Deliberately exclude real credentials and live judgment configuration.
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 10_000,
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'package-metadata-'));
  const shared = {
    version: '1.0.0', description: 'Fixture package', license: 'MIT',
    homepage: 'https://github.com/acme/fixture',
    repository: { url: 'git+https://github.com/acme/fixture.git' },
    bugs: { url: 'https://github.com/acme/fixture/issues' },
    engines: { bun: '1.3.14', node: '>=22.0.0' },
  };
  write('package.json', JSON.stringify({
    ...shared, name: 'fixture', packageManager: 'bun@1.3.14', devDependencies: { '@types/bun': '1.3.14' },
  }));
  for (const name of ['engine', 'judgment']) {
    write(`packages/${name}/package.json`, JSON.stringify({
      ...shared, name: `@acme/${name}`, keywords: ['fixture'], files: ['dist', 'README.md'],
      publishConfig: { access: 'public' },
      exports: { '.': { bun: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js' } },
    }));
    write(`packages/${name}/src/index.ts`, 'export {};\n');
    write(`packages/${name}/README.md`, `# @acme/${name}\n\nA fixture package with installation and usage documentation.\n`);
  }
  write('packages/engine/examples/package.json', JSON.stringify({ devDependencies: { '@types/bun': '^1.3.14' } }));
  write('packages/engine/platform/src/platform/node/capabilities.ts', 'export {};\n');
  write('packages/engine/contracts/src/generated/foundation-client-types.ts', 'export interface FixtureRequest {}\n');
  write('packages/engine/contracts/src/index.ts', "export type { FixtureRequest } from './generated/foundation-client-types.js';\n");
  write('offline.ts', "globalThis.fetch = async () => { console.error('Unexpected network in offline fixture'); process.exit(97); };\n");
  for (const script of SCRIPTS) {
    const destination = join(root, 'packages/engine/scripts', script);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ENGINE_ROOT, 'scripts', script), destination);
  }
  write('packages/judgment/scripts/process-owner.ts', readFileSync(resolve(ENGINE_ROOT, '../judgment/scripts/process-owner.ts'), 'utf8'));
  symlinkSync(resolve(ENGINE_ROOT, '../../node_modules'), join(root, 'node_modules'), 'junction');
  symlinkSync(resolve(ENGINE_ROOT, 'node_modules'), join(root, 'packages/engine/node_modules'), 'junction');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('required metadata checks', () => {
  test('a valid fixture passes', () => {
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('package metadata check passed (structural checks)');
  });

  test('a missing README still fails', () => {
    rmSync(join(root, 'packages/engine/README.md'));
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('is missing README.md');
  });

  test.each(['', ' \n\t\r\n'])('an empty or whitespace-only README still fails (%j)', (text) => {
    write('packages/engine/README.md', text);
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('README.md is empty');
  });

  test('invalid manifest metadata still fails ', () => {
    editManifest((manifest) => { manifest['description'] = ''; });
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('is missing required field: description');
  });

  test('an export without a backing source still fails', () => {
    rmSync(join(root, 'packages/engine/src/index.ts'));
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('source condition names a missing file');
  });

  test('an invalid wildcard export still fails', () => {
    editManifest((manifest) => { manifest['exports'] = { './*': './dist/*.js' }; });
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('must not use wildcard exports');
  });

  test('a missing required document still fails the separate documentation gate', () => {
    const result = run('docs-completeness-check.ts');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Missing required engine doc/example: ../../SECURITY.md');
  });

  test('an empty required document still fails the separate documentation gate', () => {
    write('SECURITY.md', ' \n\t');
    const result = run('docs-completeness-check.ts');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Empty required engine doc/example: ../../SECURITY.md');
  });

  test('an omitted generated type re-export still fails after README validation', () => {
    write('packages/engine/contracts/src/index.ts', 'export {};\n');
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('must re-export generated foundation client types: FixtureRequest');
  });

  test('a packageManager that disagrees with engines.bun still fails', () => {
    const path = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, packageManager: 'bun@1.3.13' }));
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('packageManager must be "bun@1.3.14"');
  });
});
