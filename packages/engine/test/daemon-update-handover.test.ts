// Proves: Updates are fetched from a repository other than the authorised one because a setting was pointed elsewhere.
// Red when: The settings manager accepts another repository, another host, or a URL carrying credentials as the release source.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOwnerActor } from '@goodvibes-jev/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';

const DAEMON_REPO_LATEST = 'https://github.com/mgd34msu/goodvibes/releases/latest';

describe('daemon update source', () => {
  test('even the owner cannot point updates at another repository or a remote host', () => {
    const root = mkdtempSync(join(tmpdir(), 'update-source-'));
    try {
      const manager = new ConfigManager({ configDir: join(root, 'surface'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
      // The owner at this machine, as the daemon's own settings writes name him.
      const owner = localOwnerActor();
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
