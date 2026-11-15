/**
 * Retiring the QEMU sandbox settings.
 *
 * The QEMU backend is gone, so the `sandbox.qemu*` keys and
 * `sandbox.replJavaScriptCommand` leave the schema, and the two settings that
 * chose a VM (`sandbox.vmBackend`, `sandbox.replIsolation`) go with them. An
 * old settings file still carries them: the load-time pass removes the retired
 * keys, files one receipt, and runs before the ingestion screen, so the loader
 * neither keeps the dead keys nor warns about a value the platform retired.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { CONFIG_SCHEMA } from '../platform/src/platform/config/schema.ts';
import { ingestSettingsFile } from '../platform/src/platform/config/settings-ingestion.ts';
import {
  migrateSandboxQemuRemoval,
  RETIRED_SANDBOX_QEMU_KEYS,
  RETIRED_SANDBOX_VM_CHOICE_FIELDS,
} from '../platform/src/platform/config/sandbox-qemu-migration.ts';
import {
  applySandboxQemuMigrationPass,
  runLoadMigrationPasses,
} from '../platform/src/platform/config/manager-migration-passes.ts';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../platform/src/platform/runtime/feature-announcements.ts';

/** A sandbox section as an install configured for QEMU wrote it. */
function qemuSandboxFile(): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      replIsolation: 'per-runtime-vm',
      mcpIsolation: 'hybrid',
      vmBackend: 'qemu',
      qemuBinary: 'qemu-system-x86_64',
      qemuImagePath: '/home/owner/.goodvibes/sandbox/guest.qcow2',
      qemuExecWrapper: '/home/owner/.goodvibes/sandbox/qemu-wrapper.sh',
      qemuGuestHost: '127.0.0.1',
      qemuGuestPort: 2222,
      qemuGuestUser: 'goodvibes',
      qemuWorkspacePath: '/workspace',
      qemuSessionMode: 'attach',
      replJavaScriptCommand: '/home/goodvibes/.bun/bin/bun',
    },
    display: { theme: 'vaporwave' },
  };
}

describe('the schema no longer offers the QEMU settings', () => {
  test('no retired QEMU key is declared', () => {
    const keys = CONFIG_SCHEMA.map((setting) => setting.key as string);
    for (const retired of RETIRED_SANDBOX_QEMU_KEYS) expect(keys).not.toContain(retired);
  });
});

const ALL_RETIRED = [...RETIRED_SANDBOX_QEMU_KEYS, ...RETIRED_SANDBOX_VM_CHOICE_FIELDS.map((field) => `sandbox.${field}`)];

describe('migrateSandboxQemuRemoval', () => {
  test('removes every retired key and keeps the rest', () => {
    const result = migrateSandboxQemuRemoval(qemuSandboxFile());
    expect(result.migrated).toBe(true);
    expect(result.removedQemuBackend).toBe(true);
    expect(result.removedKeys).toEqual(ALL_RETIRED);
    expect(result.config).toEqual({
      sandbox: { enabled: true, mcpIsolation: 'hybrid' },
      display: { theme: 'vaporwave' },
    });
  });

  test('a local backend with leftover QEMU keys loses both', () => {
    const result = migrateSandboxQemuRemoval({ sandbox: { vmBackend: 'local', qemuImagePath: '', enabled: true } });
    expect(result).toEqual({
      config: { sandbox: { enabled: true } },
      migrated: true,
      removedKeys: ['sandbox.qemuImagePath', 'sandbox.vmBackend'],
      removedQemuBackend: false,
    });
  });

  test('a sandbox section holding only retired keys goes too', () => {
    const result = migrateSandboxQemuRemoval({ sandbox: { qemuGuestPort: 2222 }, display: { theme: 'x' } });
    expect(result.config).toEqual({ display: { theme: 'x' } });
  });

  test('does not touch its input, and is idempotent', () => {
    const input = qemuSandboxFile();
    const snapshot = structuredClone(input);
    const first = migrateSandboxQemuRemoval(input);
    expect(input).toEqual(snapshot);
    const second = migrateSandboxQemuRemoval(first.config);
    expect(second.migrated).toBe(false);
    expect(second.config).toBe(first.config);
  });

  test('a file with no retired state, or a malformed sandbox section, is returned untouched', () => {
    const plain = { sandbox: { enabled: false, mcpIsolation: 'hybrid' } };
    expect(migrateSandboxQemuRemoval(plain)).toEqual({ config: plain, migrated: false, removedKeys: [], removedQemuBackend: false });
    const malformed = { sandbox: 'qemu' };
    expect(migrateSandboxQemuRemoval(malformed).config).toBe(malformed);
  });
});

describe('the load pass', () => {
  test('rewrites the file and files one receipt naming what changed', () => {
    const path = join(makeProjectTempDir('sandbox-qemu-pass'), 'settings.json');
    writeFileSync(path, JSON.stringify(qemuSandboxFile()), 'utf-8');
    const receipts: Array<[string, string]> = [];
    const migrated = applySandboxQemuMigrationPass(qemuSandboxFile(), path, (id, text) => receipts.push([id, text]));
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(migrated);
    expect(receipts.map(([id]) => id)).toEqual([`settings-migration-sandbox-qemu:${path}`]);
    const text = receipts[0]![1];
    for (const key of ALL_RETIRED) expect(text).toContain(key);
    expect(text).toContain('You had chosen the QEMU backend');
  });

  test('a file with nothing to migrate is not rewritten and files no receipt', () => {
    const receipts: string[] = [];
    const plain = { sandbox: { enabled: true } };
    const path = join(makeProjectTempDir('sandbox-qemu-noop'), 'settings.json');
    expect(applySandboxQemuMigrationPass(plain, path, (_id, text) => receipts.push(text))).toBe(plain);
    expect(receipts).toEqual([]);
  });

  test('is one of the load passes', () => {
    const path = join(makeProjectTempDir('sandbox-qemu-passes'), 'settings.json');
    const migrated = runLoadMigrationPasses(qemuSandboxFile(), path, () => undefined);
    expect(migrated['sandbox']).toEqual({ enabled: true, mcpIsolation: 'hybrid' });
    const { notices } = ingestSettingsFile(migrated, path, { write: () => undefined });
    expect(notices).toEqual([]);
  });

  test('without the pass the ingestion screen would drop vmBackend "qemu" with a notice', () => {
    const { notices } = ingestSettingsFile(qemuSandboxFile(), 'settings.json', { write: () => undefined });
    expect(notices.map((notice) => [notice.key, notice.action])).toEqual([['sandbox.vmBackend', 'skipped']]);
  });
});

describe('ConfigManager.load applies the migration', () => {
  test('the retired keys leave the file, the rest stays, and the receipt is recorded', () => {
    const configDir = makeProjectTempDir('sandbox-qemu-load');
    const path = join(configDir, 'settings.json');
    writeFileSync(path, JSON.stringify(qemuSandboxFile()), 'utf-8');
    const manager = new ConfigManager({ configDir });

    expect(manager.get('sandbox.mcpIsolation')).toBe('hybrid');

    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(onDisk['sandbox']).toEqual({ enabled: true, mcpIsolation: 'hybrid' });

    const announcements = new FeatureAnnouncementStore(featureAnnouncementsPath(manager));
    expect(announcements.has(`settings-migration-sandbox-qemu:${path}`)).toBe(true);
  });
});
