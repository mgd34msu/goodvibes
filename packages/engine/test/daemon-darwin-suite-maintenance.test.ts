/** Darwin-shaped native files exercise production maintenance without
 * executing a Mach-O program or loading SQLite. Regression source UNRUN. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonAutoUpdater } from '../sdk/src/platform/daemon/auto-updater.ts';
import { DaemonReceiptStore } from '../sdk/src/platform/daemon/receipts.ts';
import { inspectDaemonUpdateInstallation, resolveDaemonUpdateTargets } from '../sdk/src/platform/runtime/daemon-update-installation.ts';
import { realUpdateFileIo, rollbackSuiteUpdate } from '../sdk/src/platform/runtime/self-update.ts';
import { suiteReleaseFixture } from './_helpers/suite-release-fixture.ts';

for (const initiallyBusy of [false, true]) test(`Darwin daemon maintains the complete installed suite and previous cohort (initially busy=${initiallyBusy})`, async () => {
  const f = suiteReleaseFixture(), execPath = join(f.root, 'goodvibes-daemon');
  let idle = !initiallyBusy, restarts = 0;
  const receipts = new DaemonReceiptStore(join(f.root, 'receipts.json'));
  const updater = new DaemonAutoUpdater({ currentVersion: '3.1.2', execPath, platform: 'darwin', arch: 'x64',
    suite: { configManager: { get: key => key === 'controlPlane.webui.bundleDir' ? f.webui : undefined } },
    releasesLatestUrl: 'https://fixture.invalid/releases/latest',
    fetchImpl: async url => url.endsWith('/latest')
      ? new Response(null, { status: 302, headers: { location: 'https://fixture.invalid/releases/tag/v3.1.3' } })
      : f.fetchImpl(url),
    isIdle: () => idle, receipts,
    serviceActions: { isSupervised: () => true, adoptIntoService: () => { throw new Error('Unexpected adoption'); },
      restartService: () => { restarts++; return { status: 'accepted' }; } },
  });
  try {
    const targets = resolveDaemonUpdateTargets(execPath, 'darwin', 'x64');
    expect(targets).toHaveLength(5);
    expect(inspectDaemonUpdateInstallation(execPath, 'darwin', 'x64', '', realUpdateFileIo)?.version).toBe('3.1.2');
    await updater.tick();
    if (initiallyBusy) {
      expect(updater.snapshot().appliedVersion).toBeNull(); expect(restarts).toBe(0);
      for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
      idle = true; await updater.tick();
    }
    expect(updater.snapshot().appliedVersion).toBe('3.1.3'); expect(restarts).toBe(1);
    expect(receipts.list().some(receipt => receipt.text.includes('installed suite:') && receipt.text.includes('goodvibes-agent'))).toBe(true);
    const current = inspectDaemonUpdateInstallation(execPath, 'darwin', 'x64', '', realUpdateFileIo);
    const previous = inspectDaemonUpdateInstallation(execPath, 'darwin', 'x64', '.previous', realUpdateFileIo);
    expect(current?.version).toBe('3.1.3'); expect(previous?.version).toBe('3.1.2');
    expect(current?.readers?.formats).toContain('knowledge-schema-v12');
    const restored = rollbackSuiteUpdate({ execPath, platform: 'darwin', arch: 'x64', currentVersion: '3.1.3', webuiDirectory: f.webui });
    expect(restored.version).toBe('3.1.2'); expect(restored.programs).toHaveLength(3);
    for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
  } finally { updater.stop(); await updater.drainHandover(); f.cleanup(); }
});
