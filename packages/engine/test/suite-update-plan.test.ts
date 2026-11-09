/** Regression source; intentionally UNRUN during the coding-first pass. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSuiteUpdatePlan } from '../sdk/src/platform/runtime/suite-update-plan.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(programs: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-suite-plan-')); roots.push(root);
  for (const name of programs) writeFileSync(join(root, name), 'An installed synthetic program', { mode: 0o755 });
  return root;
}

for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']] as const) {
  test(`one ${platform}-${arch} selection includes every installed product and required companions`, () => {
    const root = fixture(['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']), webuiDirectory = join(root, 'webui', '3.1.1');
    mkdirSync(webuiDirectory, { recursive: true });
    const plan = resolveSuiteUpdatePlan({ execPath: join(root, 'goodvibes'), platform, arch, version: 'v3.1.2', webuiDirectory });
    expect(plan.programs.map(program => program.name).sort()).toEqual(['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']);
    expect(new Set(plan.files.map(file => file.path)).size).toBe(plan.files.length);
    expect(plan.files.filter(file => file.label === 'SQLite vector extension' || file.assetName === `sqlite-vec-${platform}-${arch}.${platform === 'linux' ? 'so' : 'dylib'}`)).toHaveLength(1);
    expect(plan.directories).toMatchObject([{ kind: 'browser-driver', path: join(root, 'playwright-core') }, { kind: 'webui', path: webuiDirectory, assetName: 'goodvibes-webui-bundle-3.1.2.tar.gz' }]);
    if (platform === 'linux') {
      for (const program of plan.programs) for (const ending of ['.bun', '.bun.LICENSE.md', '.bun.json']) expect(plan.files.some(file => file.path === program.path + ending)).toBe(true);
      expect(plan.files.some(file => file.path === join(root, 'daemon-installation.json'))).toBe(true);
    } else {
      expect(plan.files.some(file => file.assetName.endsWith('.bun'))).toBe(false);
      expect(plan.files.some(file => file.path === join(root, 'lib', `sqlite-darwin-${arch}`, 'libsqlite3.dylib'))).toBe(true);
      expect(plan.files.some(file => file.path === join(root, 'lib', `sqlite-darwin-${arch}`, 'libsqlite3.dylib.json'))).toBe(true);
    }
    plan.assertCurrent();
  });
}

test('an opted-out Agent and an unconfigured WebUI stay absent from the update', () => {
  const root = fixture(['goodvibes', 'goodvibes-daemon']);
  const plan = resolveSuiteUpdatePlan({ execPath: join(root, 'goodvibes'), platform: 'linux', arch: 'x64', version: '3.1.2' });
  expect(plan.programs.some(program => program.name === 'goodvibes-agent')).toBe(false);
  expect(plan.files.some(file => file.path.startsWith(join(root, 'goodvibes-agent')))).toBe(false);
  expect(plan.directories.some(directory => directory.kind === 'webui')).toBe(false);
  writeFileSync(join(root, 'goodvibes-agent'), 'A peer appeared after selection', { mode: 0o755 });
  expect(() => plan.assertCurrent()).toThrow('selection changed');
});

test('retains the actual directly downloaded invoking path without inventing a duplicate canonical terminal', () => {
  const root = fixture(['goodvibes-linux-x64', 'goodvibes-daemon']);
  const plan = resolveSuiteUpdatePlan({ execPath: join(root, 'goodvibes-linux-x64'), platform: 'linux', arch: 'x64', version: '3.1.2' });
  expect(plan.programs.find(program => program.name === 'goodvibes')?.path).toBe(join(root, 'goodvibes-linux-x64'));
  expect(plan.files.some(file => file.path === join(root, 'goodvibes'))).toBe(false);
});

test('a directly downloaded executable never silently leaves a canonical sibling at another release', () => {
  const root = fixture(['goodvibes-linux-x64', 'goodvibes']);
  expect(() => resolveSuiteUpdatePlan({ execPath: join(root, 'goodvibes-linux-x64'), platform: 'linux', arch: 'x64', version: '3.1.2' })).toThrow('Run ' + join(root, 'goodvibes'));
});

test('does not infer a selected WebUI from unrelated old version directories', () => {
  const root = fixture(['goodvibes']); mkdirSync(join(root, 'webui', '3.0.0'), { recursive: true });
  const plan = resolveSuiteUpdatePlan({ execPath: join(root, 'goodvibes'), platform: 'darwin', arch: 'arm64', version: '3.1.2' });
  expect(plan.directories.map(directory => directory.kind)).toEqual(['browser-driver']);
  expect(() => resolveSuiteUpdatePlan({ execPath: join(root, 'goodvibes'), platform: 'darwin', arch: 'arm64', version: '3.1.2', webuiDirectory: join(root, 'private-site') })).toThrow('separately managed');
});
