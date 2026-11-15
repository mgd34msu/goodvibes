import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadPersistedProviders,
  persistProviders,
  removePersistedProviders,
  type DiscoveredServer,
} from '../platform/src/platform/discovery/scanner.js';

const surfaceRoot = 'gv-test-surface';
let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'gv-discovery-aging-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const roots = () => ({ homeDirectory: tmp, surfaceRoot });
const cachePath = () => join(tmp, '.goodvibes', surfaceRoot, 'discovered-providers.json');
const server = (host: string, port = 1234): DiscoveredServer => ({
  name: `Local ${host}`, host, port, baseURL: `http://${host}:${port}/v1`, models: ['m'], serverType: 'unknown',
});
const seed = (entries: unknown[]): void => {
  mkdirSync(dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(entries), 'utf-8');
};
const hosts = (): string[] => (JSON.parse(readFileSync(cachePath(), 'utf-8')) as Array<{ host: string }>).map((entry) => entry.host).sort();

describe('the persisted provider cache', () => {
  test('an entry not seen for longer than the retention window is dropped when the cache is next written', () => {
    seed([
      { ...server('10.0.0.5'), lastSeen: 1 },
      { ...server('10.0.0.6'), lastSeen: Date.now() },
    ]);
    persistProviders(roots(), [server('10.0.0.7')]);
    expect(hosts()).toEqual(['10.0.0.6', '10.0.0.7']);
  });

  test('an entry the loader would reject is not carried forward', () => {
    seed([{ host: '10.0.0.8', port: 1, models: [], lastSeen: Date.now() }, { ...server('10.0.0.9'), lastSeen: Date.now() }]);
    persistProviders(roots(), [server('10.0.0.10')]);
    expect(hosts()).toEqual(['10.0.0.10', '10.0.0.9']);
    expect(loadPersistedProviders(roots()).map((entry) => entry.host).sort()).toEqual(['10.0.0.10', '10.0.0.9']);
  });

  test('removal keeps the other entries, drops aged ones, and leaves no temporary file', () => {
    seed([
      { ...server('10.0.0.1'), lastSeen: Date.now() },
      { ...server('10.0.0.2'), lastSeen: Date.now() },
      { ...server('10.0.0.3'), lastSeen: 1 },
    ]);
    removePersistedProviders(roots(), [{ host: '10.0.0.1', port: 1234 }]);
    expect(hosts()).toEqual(['10.0.0.2']);
    expect(readdirSync(dirname(cachePath())).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
