/**
 * Plugin discovery: which directories are searched, which manifests are
 * accepted, and which copy wins when two plugins share a name.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { discoverPlugins, getUserPluginDirectory } from '../platform/src/platform/plugins/index.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-plugin-smoke-'));
  tmpRoots.push(dir);
  return dir;
}

function writePlugin(root: string, folder: string, manifest: Record<string, unknown>): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('platform/plugins: discovery', () => {
  test('finds nothing when no plugin directory exists', () => {
    const dir = makeTmpDir();
    expect(discoverPlugins({ cwd: dir, homeDir: dir })).toEqual([]);
  });

  test('finds valid plugins in the project and the user directory, and skips invalid manifests', () => {
    const cwd = makeTmpDir();
    const homeDir = makeTmpDir();
    const projectPlugins = join(cwd, '.goodvibes', 'plugins');
    const projectDir = writePlugin(projectPlugins, 'alpha', { name: 'alpha', version: '1.0.0', description: 'a' });
    const userDir = writePlugin(getUserPluginDirectory({ cwd, homeDir }), 'beta', { name: 'beta', version: '2.0.0', description: 'b' });
    writePlugin(projectPlugins, 'bad-name', { name: 'Bad Name', version: '1.0.0', description: 'x' });
    writePlugin(projectPlugins, 'no-version', { name: 'no-version', description: 'x' });
    writePlugin(projectPlugins, 'absolute-main', { name: 'absolute-main', version: '1.0.0', description: 'x', main: '/etc/passwd' });

    const found = discoverPlugins({ cwd, homeDir });
    expect(found.map((plugin) => [plugin.manifest.name, plugin.pluginDir]).sort()).toEqual([
      ['alpha', projectDir],
      ['beta', userDir],
    ]);
  });

  test('a project plugin shadows a user plugin with the same name', () => {
    const cwd = makeTmpDir();
    const homeDir = makeTmpDir();
    const projectDir = writePlugin(join(cwd, '.goodvibes', 'plugins'), 'shared', { name: 'shared', version: '2.0.0', description: 'project' });
    writePlugin(getUserPluginDirectory({ cwd, homeDir }), 'shared', { name: 'shared', version: '1.0.0', description: 'user' });

    const found = discoverPlugins({ cwd, homeDir });
    expect(found).toHaveLength(1);
    expect(found[0]!.pluginDir).toBe(projectDir);
    expect(found[0]!.manifest.version).toBe('2.0.0');
  });

  test('the user plugin directory lives under the home directory', () => {
    const homeDir = makeTmpDir();
    expect(getUserPluginDirectory({ cwd: '/unused', homeDir })).toBe(join(homeDir, '.goodvibes', 'plugins'));
  });
});
