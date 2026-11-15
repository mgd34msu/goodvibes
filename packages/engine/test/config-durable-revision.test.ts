/**
 * The durable configuration revision a saved grant is bound to: the same after
 * a restart with unchanged files, different after any change, including one
 * that was undone and a hand edit made while nothing ran. And a settings write
 * never hides an edit another writer made to the same file.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-durable-revision-'));
  roots.push(root);
  return join(root, 'surface');
}

test('the revision survives a restart with unchanged files and moves on a change that was undone', () => {
  const dir = configDir();
  const first = new ConfigManager({ configDir: dir });
  first.set('display.theme', 'nord' as never);
  const issued = first.captureDurableConfigurationIncarnation();
  expect(new ConfigManager({ configDir: dir }).getDurableConfigurationIncarnation()).toBe(issued);

  const original = first.get('display.theme');
  first.set('display.theme', 'dracula' as never);
  first.set('display.theme', original as never);
  expect(first.getDurableConfigurationIncarnation()).not.toBe(issued);
  expect(new ConfigManager({ configDir: dir }).getDurableConfigurationIncarnation()).not.toBe(issued);
  // No lock directory or per-file sidecar is left beside the settings.
  expect(readdirSync(dir).filter(name => name.endsWith('.owner-lock') || name.endsWith('.policy-epoch.json'))).toEqual([]);
});

test('a hand edit made while nothing ran moves the revision, and restoring the bytes does not undo it', () => {
  const dir = configDir();
  const first = new ConfigManager({ configDir: dir });
  first.set('display.theme', 'nord' as never);
  const issued = first.captureDurableConfigurationIncarnation();
  const path = first.getConfigPath(), bytes = readFileSync(path);

  writeFileSync(path, JSON.stringify({ display: { theme: 'dracula' } }));
  const edited = new ConfigManager({ configDir: dir }).getDurableConfigurationIncarnation();
  expect(edited).not.toBe(issued);
  writeFileSync(path, bytes);
  const restored = new ConfigManager({ configDir: dir }).getDurableConfigurationIncarnation();
  expect(restored).not.toBe(issued);
  expect(restored).not.toBe(edited);
});

test('an edit another writer made since the last poll is loaded, not hidden, when this manager writes the same file', async () => {
  const dir = configDir();
  const manager = new ConfigManager({ configDir: dir });
  manager.set('display.theme', 'nord' as never);
  manager.watchConfigFiles({ intervalMs: 3_600_000 });
  try {
    const seen: unknown[] = [];
    manager.subscribe('display.theme', next => { seen.push(next); });
    const path = manager.getConfigPath();
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    writeFileSync(path, JSON.stringify({ ...onDisk, display: { ...onDisk.display, theme: 'dracula' } }));

    manager.set('behavior.autoApprove', false);
    await Promise.resolve();
    expect(manager.get('display.theme')).toBe('dracula');
    expect(seen).toEqual(['dracula']);
    manager.save();
    expect((JSON.parse(readFileSync(path, 'utf8')) as { display: { theme: string } }).display.theme).toBe('dracula');
  } finally { manager.stopWatchingConfigFiles(); }
  expect(existsSync(manager.getConfigPath())).toBe(true);
});
