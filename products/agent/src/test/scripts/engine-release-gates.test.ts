/** Agent adapter contracts: installable engine package, public exports and root lock. */
import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  agentEnginePin,
  readEnginePin,
  enginePinAgreementIssues,
  engineReleaseGateIssues,
} from '../../../scripts/engine-release-gates.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const engine = '@goodvibes-jev/engine';
const PUBLIC_IMPORT = `${engine}/platform/platform/state`;

interface FixtureSpec {
  readonly pin?: string;
  readonly installedVersion?: string | null;
  readonly lockPin?: string | null;
  readonly localLockPin?: string;
  readonly devPin?: string;
  readonly srcFiles?: Record<string, string>;
}

const created: string[] = [];
const AGENT_ROOT = resolve(import.meta.dir, '../../..');

function makeFixture(spec: FixtureSpec = {}): string {
  const repository = makeProjectTempDir('gv-engine-gate');
  created.push(repository);
  const root = join(repository, 'products', 'agent');
  mkdirSync(root, { recursive: true });
  // The gate runs with the pin shape the product declares, so the fixture carries the real one.
  copyFileSync(join(AGENT_ROOT, 'toolchain.config.json'), join(root, 'toolchain.config.json'));
  const pin = spec.pin ?? 'workspace:*';
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ private: true, workspaces: ['products/*', 'packages/*'] }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@goodvibes-jev/agent', version: '2.1.0', private: true,
    dependencies: { [engine]: pin },
    ...(spec.devPin === undefined ? {} : { devDependencies: { [engine]: spec.devPin } }),
  }));

  // The shared gate proves manifest presence only.
  if (spec.installedVersion !== null) {
    const pkgDir = join(root, 'node_modules', engine);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: engine,
      version: spec.installedVersion ?? '2.0.23',
      exports: { '.': './index.js', './platform': './platform/index.js', './platform/platform/state': './platform/state.js', './platform/platform/tools': './platform/tools.js', './toolchain': './toolchain/index.js' },
    }));
  }

  const lockPin = spec.lockPin === undefined ? pin : spec.lockPin;
  const lockText = (value: string | null): string => JSON.stringify({
    lockfileVersion: 1,
    packages: value === null ? {} : { [engine]: [`${engine}@${value.startsWith('workspace:') ? 'workspace:packages/engine' : value}`] },
  });
  writeFileSync(join(repository, 'bun.lock'), lockText(lockPin));
  // A stale nested lock cannot rescue or invalidate the authoritative root lock.
  if (spec.localLockPin !== undefined) writeFileSync(join(root, 'bun.lock'), lockText(spec.localLockPin));

  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  for (const [relative, body] of Object.entries(spec.srcFiles ?? { 'clean.ts': `import { x } from '${PUBLIC_IMPORT}';\n` })) {
    const path = join(srcDir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine-release-gates', () => {
  test('the pin shape is the one toolchain.config.json declares: the installable package, the root lock and the exports map', () => {
    expect(agentEnginePin(AGENT_ROOT)).toMatchObject({ enginePackage: '@goodvibes-jev/engine', pinSource: 'dependencies', lockfile: '../../bun.lock', enforceExportsMap: true });
  });

  test('the actual Agent workspace passes every engine gate', () => {
    expect(readEnginePin(AGENT_ROOT)).toBe('workspace:*');
    expect(engineReleaseGateIssues(AGENT_ROOT)).toEqual([]);
  });

  test('clean workspace fixture passes presence, root-lock and public-import gates', () => {
    expect(engineReleaseGateIssues(makeFixture())).toEqual([]);
  });

  test.each(['2.0.23', '^2.0.23', 'latest', 'file:../../packages/engine'])('a dependency other than the workspace (%s) fails', (pin) => {
    expect(enginePinAgreementIssues(makeFixture({ pin })).some((issue) => issue.includes('must be a workspace dependency'))).toBe(true);
  });

  test('a missing installed engine fails', () => {
    const issues = enginePinAgreementIssues(makeFixture({ installedVersion: null }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('not installed');
  });

  test.each([
    { pin: 'workspace:*', lockPin: '2.0.23' },
    { pin: 'workspace:*', lockPin: null },
  ])('root-lock mismatch blocks even when a local lock agrees: %j', (spec) => {
    const issues = enginePinAgreementIssues(makeFixture({ ...spec, localLockPin: spec.pin }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('../../bun.lock does not resolve');
  });

  test('an obsolete local lock does not override a correct root lock', () => {
    expect(engineReleaseGateIssues(makeFixture({ localLockPin: '0.1.0' }))).toEqual([]);
  });

  test.each([
    `../../../goodvibes/platform/dist/secret.js`,
    `../../../packages/${'engine'}/platform/src/private.ts`,
  ])('relative private engine source imports are caught: %s', (specifier) => {
    const root = makeFixture({ srcFiles: { 'bad.ts': `import { secret } from '${specifier}';\n` } });
    expect(engineReleaseGateIssues(root).some((issue) => issue.includes('non-npm goodvibes import'))).toBe(true);
  });

  test('package-qualified private engine imports are rejected by the exports map', () => {
    const root = makeFixture({ srcFiles: { 'bad.ts': `import { secret } from '${engine}/engine/src/private';\n` } });
    const issues = engineReleaseGateIssues(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('not in the published exports map');
  });

  test('public engine platform and toolchain exports pass', () => {
    const root = makeFixture({ srcFiles: {
      'public.ts': `import { platform } from '${engine}/platform';\nimport { state } from '${PUBLIC_IMPORT}';\nimport { tools } from '${engine}/toolchain';\n`,
    } });
    expect(engineReleaseGateIssues(root)).toEqual([]);
  });

  test('readEnginePin reads the authoritative dependencies group rather than a stale dev pin', () => {
    expect(readEnginePin(makeFixture({ devPin: '0.38.0' }))).toBe('workspace:*');
  });
});
