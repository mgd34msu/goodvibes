import { expect, mock, test } from 'bun:test';

const realMigration = await import('../platform/src/platform/config/daemon-config-migration.js');
const realTier = await import('../platform/src/platform/config/shared-config-tier.js');
mock.module('../platform/src/platform/config/daemon-config-migration.js', () => ({ ...realMigration,
  migrateDaemonOwnedConfig: () => ({ migrated: true, markerPath: '/ledger', marker: { movedTo: '/daemon/settings.json', moved: [{ key: 'surfaces.example' }], discarded: [] } }) }));
mock.module('../platform/src/platform/config/shared-config-tier.js', () => ({ ...realTier,
  raiseReaderFloorInFile: () => { throw new Error('settings file is read-only'); } }));
const { migrateDaemonOwnedConfigOnBoot } = await import('../platform/src/platform/daemon/facade-boot-guarantees.js');

test('settings the migration already moved on disk are reloaded even when recording the reader floor fails', () => {
  let loads = 0;
  migrateDaemonOwnedConfigOnBoot({ getDaemonTierPath: () => '/daemon/settings.json', load: () => { loads++; } } as never, '/home/owner');
  expect(loads).toBe(1);
});
