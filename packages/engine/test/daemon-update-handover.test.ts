import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { updateConfigDefaults, updateConfigSettings } from '../platform/src/platform/config/schema-domain-update.js';
import { resolveDaemonInstalledFiles } from '../platform/src/platform/daemon/auto-updater.js';
import { inspectDaemonNativeInstallation, resolveDaemonNativePayloads } from '../platform/src/platform/runtime/self-update.js';
import { nativeCohortFixture, nativeMemoryIo } from './_helpers/daemon-native-cohort.ts';

const DAEMON_REPO_LATEST = 'https://github.com/mgd34msu/goodvibes/releases/latest';
const execPath = '/home/someone/.local/bin/goodvibes-daemon';
const cohort = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'native-daemon' });
const ownedPaths = [execPath, `${execPath}.bun`, `${execPath}.bun.LICENSE.md`, `${execPath}.bun.json`,
  '/home/someone/.local/bin/lib/sqlite-vec-linux-x64/vec0.so', '/home/someone/.local/bin/daemon-installation.json'];

function installation(extra: Record<string, Buffer> = {}) {
  return nativeMemoryIo({ ...cohort.installation(execPath), ...extra });
}

describe('daemon update source', () => {
  test('the shipped default names the authorized Jev release repository', () => {
    expect(updateConfigDefaults.update.releasesUrl).toBe(DAEMON_REPO_LATEST);
  });

  test('the settings definition and defaults object have the same release source', () => {
    const definition = updateConfigSettings.find(setting => setting.key === 'update.releasesUrl');
    expect(definition?.default).toBe(DAEMON_REPO_LATEST);
  });

  test('even the owner cannot point updates at another repository or a remote host', () => {
    const root = mkdtempSync(join(tmpdir(), 'update-source-'));
    try {
      const manager = new ConfigManager({ configDir: join(root, 'surface'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
      const owner = { kind: 'owner', surface: 'fixture' } as const;
      const key = 'update.releasesUrl' as ConfigKey;
      for (const foreign of ['https://github.com/someone-else/goodvibes/releases/latest', 'https://example.com/mgd34msu/goodvibes/releases/latest',
        'https://user:secret@github.com/mgd34msu/goodvibes/releases/latest', 'http://192.0.2.10/releases/latest']) {
        expect(manager.setMany([{ key, value: foreign }], owner).ok).toBe(false);
        expect(manager.get(key)).toBe(DAEMON_REPO_LATEST);
      }
      expect(manager.setMany([{ key, value: 'https://github.com/mgd34msu/goodvibes/releases/tag/v3.2.0' }], owner).ok).toBe(true);
      expect(manager.setMany([{ key, value: 'http://127.0.0.1:4100/releases/latest' }], owner).ok).toBe(true);
      expect(new ConfigManager({ configDir: join(root, 'surface'), daemonTierPath: join(root, 'daemon', 'settings.json') }).get(key)).toBe('http://127.0.0.1:4100/releases/latest');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the complete native daemon installation', () => {
  test('the five payload descriptors are fixed and include the runtime and its provenance', () => {
    expect(resolveDaemonNativePayloads('linux', 'x64')).toEqual([
      { relativePath: 'goodvibes-daemon-linux-x64', assetName: 'goodvibes-daemon-linux-x64', executable: true },
      { relativePath: 'goodvibes-daemon-linux-x64.bun', assetName: 'goodvibes-daemon-linux-x64.bun', executable: true },
      { relativePath: 'goodvibes-daemon-linux-x64.bun.LICENSE.md', assetName: 'goodvibes-daemon-linux-x64.bun.LICENSE.md', executable: false },
      { relativePath: 'goodvibes-daemon-linux-x64.bun.json', assetName: 'goodvibes-daemon-linux-x64.bun.json', executable: false },
      { relativePath: 'lib/sqlite-vec-linux-x64/vec0.so', assetName: 'sqlite-vec-linux-x64.so', executable: false },
    ]);
  });

  test('a daemon update owns every payload and the installation receipt', () => {
    const { io } = installation();
    const verified = inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', io);
    expect(verified?.version).toBe('2.0.23'); expect(verified?.artifact).toEqual(cohort.artifact);
    const files = resolveDaemonInstalledFiles({ execPath, platform: 'linux', arch: 'x64', io });
    expect(files.map(file => file.path)).toEqual(ownedPaths);
    expect(files.map(file => file.assetName)).toEqual([
      'goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md',
      'goodvibes-daemon-linux-x64.bun.json', 'sqlite-vec-linux-x64.so', 'goodvibes-daemon-linux-x64.ci-artifact.json',
    ]);
    expect(files.map(file => file.executable)).toEqual([true, true, false, false, false, false]);
  });

  test('sibling product executables remain outside the daemon installation', () => {
    const siblings = ['/home/someone/.local/bin/goodvibes', '/home/someone/.local/bin/goodvibes-agent', '/home/someone/.local/bin/goodvibes-webui'];
    const { io } = installation(Object.fromEntries(siblings.map(path => [path, Buffer.from('sibling-product')])));
    const files = resolveDaemonInstalledFiles({ execPath, platform: 'linux', arch: 'x64', io });
    expect(files.map(file => file.path)).toEqual(ownedPaths);
    for (const sibling of siblings) expect(files.map(file => file.path)).not.toContain(sibling);
  });

  for (const missing of ownedPaths) {
    test(`inspection refuses the incomplete installation missing ${missing}`, () => {
      const memory = installation();
      memory.io.remove?.(missing);
      expect(() => inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', memory.io)).toThrow();
      expect(memory.files.has(`${execPath}.previous`)).toBe(false);
    });
  }

  test('an installation with altered runtime bytes is refused by installation admission', () => {
    const memory = installation();
    memory.io.writeFile(`${execPath}.bun`, Buffer.from('different-runtime'));
    expect(() => inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', memory.io)).toThrow();
  });

  test('an executable mode change is refused even when the bytes still match', () => {
    const memory = installation();
    memory.io.chmod(`${execPath}.bun`, 0o644);
    expect(() => inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', memory.io)).toThrow();
  });

  test('the arm64 installation owns its matching complete cohort', () => {
    const arm = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'arm-daemon', arch: 'arm64' });
    const memory = nativeMemoryIo(arm.installation(execPath));
    const verified = inspectDaemonNativeInstallation(execPath, 'linux', 'arm64', '', memory.io);
    expect(verified?.version).toBe('2.0.23'); expect(verified?.artifact).toEqual(arm.artifact);
    const files = resolveDaemonInstalledFiles({ execPath, platform: 'linux', arch: 'arm64', io: memory.io });
    expect(files.map(file => file.path)).toEqual([
      execPath, `${execPath}.bun`, `${execPath}.bun.LICENSE.md`, `${execPath}.bun.json`,
      '/home/someone/.local/bin/lib/sqlite-vec-linux-arm64/vec0.so', '/home/someone/.local/bin/daemon-installation.json',
    ]);
    expect(files.every(file => file.assetName?.includes('linux-arm64'))).toBe(true);
  });

  for (const arch of ['x64', 'arm64']) {
    test(`Darwin ${arch} selects its complete reader-artifact and SQLite cohort`, () => {
      // The Linux installation-receipt resolver intentionally remains Linux
      // only. Darwin updates use their own compiled reader artifact layout.
      expect(resolveDaemonNativePayloads('darwin', arch)).toBeNull();
      const files = resolveDaemonInstalledFiles({ execPath, platform: 'darwin', arch });
      expect(files.map(file => file.path)).toEqual([
        execPath, `${execPath}.readers.json`,
        `/home/someone/.local/bin/lib/sqlite-vec-darwin-${arch}/vec0.dylib`,
        `/home/someone/.local/bin/lib/sqlite-darwin-${arch}/libsqlite3.dylib`,
        `/home/someone/.local/bin/lib/sqlite-darwin-${arch}/libsqlite3.dylib.json`,
      ]);
      expect(files.map(file => file.assetName)).toEqual([
        `goodvibes-daemon-macos-${arch}`, `goodvibes-daemon-macos-${arch}.reader-ci-artifact.json`,
        `sqlite-vec-darwin-${arch}.dylib`, `sqlite-darwin-${arch}.dylib`, `sqlite-darwin-${arch}.dylib.json`,
      ]);
      expect(files.map(file => file.executable)).toEqual([true, false, false, false, false]);
    });
  }

  test('Windows and an unsupported Darwin architecture have no downloadable daemon cohort', () => {
    expect(resolveDaemonNativePayloads('win32', 'x64')).toBeNull();
    expect(resolveDaemonInstalledFiles({ execPath, platform: 'win32', arch: 'x64' })).toEqual([]);
    expect(resolveDaemonInstalledFiles({ execPath, platform: 'darwin', arch: 'ia32' })).toEqual([]);
  });
});
