import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';

const roots: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gv-path-${label}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('ConfigManager path accessors', () => {
  test('an explicit configDir holds the global settings file and is the control-plane directory', () => {
    const configDir = tempDir('config-path');
    const mgr = new ConfigManager({ configDir });
    expect(mgr.getConfigPath()).toBe(join(configDir, 'settings.json'));
    expect(mgr.getControlPlaneConfigDir()).toBe(configDir);
  });

  test('there is no project settings path without a working directory', () => {
    expect(new ConfigManager({ configDir: tempDir('no-working-dir') }).getProjectConfigPath()).toBeUndefined();
  });

  test('home and working directories derive the global and project paths under the surface directory', () => {
    const homeDir = tempDir('home');
    const workingDir = tempDir('working');
    const mgr = new ConfigManager({ homeDir, workingDir, surfaceRoot: 'cli' });
    expect(mgr.getConfigPath()).toBe(join(homeDir, '.goodvibes', 'cli', 'settings.json'));
    expect(mgr.getProjectConfigPath()).toBe(join(workingDir, '.goodvibes', 'cli', 'settings.json'));
    expect(mgr.getControlPlaneConfigDir()).toBe(join(homeDir, '.goodvibes', 'cli'));
  });
});
