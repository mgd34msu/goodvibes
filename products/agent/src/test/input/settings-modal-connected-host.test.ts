/**
 * What the settings modal shows after a setting is written to the connected host,
 * and how edits and resets that are refused are reported.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { ServiceRegistry, SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/platform/platform/payments';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { SettingsModal, type SettingEntry } from '../../input/settings-modal.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { installAgentDaemonConfigClient, isDaemonOwnedConfigKey } from '../../config/daemon-config-routing.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface FakeHost {
  readonly sets: Array<{ key: string; value: unknown }>;
  /** Resolves the oldest pending `set`. */
  release(): void;
  held: Map<string, unknown>;
}

/** A connected host that owns every daemon-owned key; `set` waits until the test releases it. */
function installHost(options: { readonly clamp?: (key: string, value: unknown) => unknown } = {}): FakeHost {
  const sets: Array<{ key: string; value: unknown }> = [];
  const waiting: Array<() => void> = [];
  const held = new Map<string, unknown>();
  installAgentDaemonConfigClient({
    ownsKey: (key: string) => isDaemonOwnedConfigKey(key),
    set: (key: string, value: unknown) => new Promise<void>((resolve) => {
      sets.push({ key, value });
      waiting.push(() => {
        held.set(key, options.clamp ? options.clamp(key, value) : value);
        resolve();
      });
    }),
    get: async (key: string) => held.get(key),
    snapshot: async () => ({}),
  } as never);
  return { sets, held, release: () => waiting.shift()?.() };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('SettingsModal with a connected host', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let root: string;
  let cm: ConfigManager;
  let modal: SettingsModal;
  let renders: number;
  let subscriptions: SubscriptionManager;
  let services: ServiceRegistry;

  beforeEach(() => {
    root = makeProjectTempDir('gv-settings-connected-host');
    process.env.HOME = root;
    process.chdir(root);
    mkdirSync(join(root, '.goodvibes', 'agent'), { recursive: true });
    cm = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'global-agent') });
    subscriptions = new SubscriptionManager(join(root, '.goodvibes', 'agent', 'subscriptions.json'));
    services = new ServiceRegistry(join(root, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root, configManager: cm }),
      subscriptionManager: subscriptions,
    });
    modal = new SettingsModal();
    renders = 0;
    modal.open(cm, createFeatureFlagManager(), subscriptions, services, { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry, undefined, {
      requestRender: () => { renders += 1; },
    });
  });

  afterEach(() => {
    installAgentDaemonConfigClient(null);
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  function select(key: string): void {
    for (let pass = 0; pass < 40; pass++) {
      const index = modal.currentItems.findIndex((entry) => entry.setting.key === key);
      if (index >= 0) {
        modal.selectedIndex = index;
        return;
      }
      modal.nextCategory();
    }
    throw new Error(`${key} is not in the settings modal`);
  }

  function selectFirst(match: (entry: SettingEntry) => boolean): void {
    for (let pass = 0; pass < 40; pass++) {
      const index = modal.currentItems.findIndex(match);
      if (index >= 0) {
        modal.selectedIndex = index;
        return;
      }
      modal.nextCategory();
    }
    throw new Error('no matching setting in the settings modal');
  }

  test('the row shows the value the host holds after a routed write, not the unchanged local value', async () => {
    const host = installHost();
    select('payments.cvvHandling');
    const entry = modal.getSelected()!;
    expect(entry.currentValue).not.toBe('prompt');
    modal.activateSelected();
    expect(host.sets).toEqual([{ key: 'payments.cvvHandling', value: 'prompt' }]);
    expect(modal.lastSettingEffectMessage).toBe('Saving on the connected host…');
    host.release();
    await settle();
    expect(modal.getSelected()!.currentValue).toBe('prompt');
    expect(modal.getSelected()!.isDefault).toBe(false);
    expect(cm.get('payments.cvvHandling')).not.toBe('prompt');
    expect(renders).toBeGreaterThan(0);
  });

  test('a value the host clamps is shown as the host holds it', async () => {
    const host = installHost({ clamp: () => 'stored' });
    select('payments.cvvHandling');
    modal.activateSelected();
    host.release();
    await settle();
    expect(modal.getSelected()!.currentValue).toBe('stored');
  });

  test('the CVV trade-off warning follows a routed write, after the host reports', async () => {
    const host = installHost();
    select('payments.cvvHandling');
    modal.activateSelected();
    host.release();
    await settle();
    expect(modal.lastSettingEffectMessage).toBe(CVV_PROMPT_TRADEOFF_WARNING);
  });

  test('a host-held setting row keeps the host value when other rows refresh', async () => {
    const host = installHost();
    select('payments.cvvHandling');
    modal.activateSelected();
    host.release();
    await settle();
    expect(modal.getSelected()!.currentValue).toBe('prompt');
    modal.refreshPickerValues();
    select('payments.cvvHandling');
    expect(modal.getSelected()!.currentValue).toBe('prompt');
    expect(modal.getSelected()!.isDefault).toBe(false);
  });

  test('a host-held feature flag keeps its state after another flag is toggled and after a tab round trip', async () => {
    const host = installHost();
    while (modal.currentCategory !== 'flags') modal.nextCategory();
    const owned = modal.flagEntries.findIndex((entry) =>
      entry.feature.enablement.kind !== 'constant' && isDaemonOwnedConfigKey(entry.feature.enablement.key));
    const other = modal.flagEntries.findIndex((entry, i) =>
      i !== owned && entry.feature.enablement.kind !== 'constant' && !isDaemonOwnedConfigKey(entry.feature.enablement.key));
    expect(owned).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    const ownedId = modal.flagEntries[owned]!.feature.id;
    const wasEnabled = modal.flagEntries[owned]!.state === 'enabled';
    modal.selectedIndex = owned;
    modal.toggleSelectedFlag();
    host.release();
    await settle();
    const expected = wasEnabled ? 'disabled' : 'enabled';
    expect(modal.flagEntries.find((e) => e.feature.id === ownedId)!.state).toBe(expected);
    modal.selectedIndex = other;
    modal.toggleSelectedFlag();
    expect(modal.flagEntries.find((e) => e.feature.id === ownedId)!.state).toBe(expected);
    modal.nextCategory();
    modal.prevCategory();
    expect(modal.flagEntries.find((e) => e.feature.id === ownedId)!.state).toBe(expected);
  });

  test('a change made while the same key is saving is sent after it, so the host ends on the newest value', async () => {
    const host = installHost();
    selectFirst((entry) => entry.setting.type === 'number' && isDaemonOwnedConfigKey(entry.setting.key)
      && [41, 42, 43].every((n) => entry.setting.validate?.(n) ?? true));
    const key = modal.getSelected()!.setting.key;
    for (const typed of ['41', '42', '43']) {
      modal.activateSelected();
      modal.editBuffer = typed;
      expect(modal.commitEdit()).toBe(true);
    }
    // One write per key at a time; the middle value was replaced before it was sent.
    expect(host.sets).toEqual([{ key, value: 41 }]);
    host.release();
    await settle();
    expect(host.sets).toEqual([{ key, value: 41 }, { key, value: 43 }]);
    host.release();
    await settle();
    expect(host.held.get(key)).toBe(43);
    expect(modal.getSelected()!.currentValue).toBe(43);
  });

  test('an answer that arrives after the modal was closed does not touch it', async () => {
    const host = installHost();
    select('payments.cvvHandling');
    modal.activateSelected();
    modal.close();
    modal.lastSettingEffectMessage = null;
    host.release();
    await settle();
    expect(modal.lastSettingEffectMessage).toBeNull();
  });

  test('a feature toggle in the flags tab goes to the host that owns its key, not the local store', async () => {
    const host = installHost();
    while (modal.currentCategory !== 'flags') modal.nextCategory();
    const index = modal.flagEntries.findIndex((entry) =>
      entry.feature.enablement.kind !== 'constant' && isDaemonOwnedConfigKey(entry.feature.enablement.key));
    expect(index).toBeGreaterThanOrEqual(0);
    const flag = modal.flagEntries[index]!;
    const key = flag.feature.enablement.key;
    const before = cm.getStored(key as never);
    const wasEnabled = flag.state === 'enabled';
    modal.selectedIndex = index;
    modal.toggleSelectedFlag();
    expect(host.sets).toHaveLength(1);
    expect(host.sets[0]!.key).toBe(key);
    expect(cm.getStored(key as never)).toEqual(before);
    host.release();
    await settle();
    expect(modal.flagEntries[index]!.state).toBe(wasEnabled ? 'disabled' : 'enabled');
  });

  test('a feature toggle runs the same apply hook as a settings row, so a refused key is refused here too', () => {
    modal.open(cm, createFeatureFlagManager(), subscriptions, services, { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry, undefined, {
      onSettingApplied: (change) => (change.key === 'service.enabled' ? { message: 'refused by the connected-host boundary' } : undefined),
    });
    while (modal.currentCategory !== 'flags') modal.nextCategory();
    const index = modal.flagEntries.findIndex((entry) => entry.feature.enablement.key === 'service.enabled');
    expect(index).toBeGreaterThanOrEqual(0);
    modal.selectedIndex = index;
    modal.toggleSelectedFlag();
    expect(modal.lastSettingEffectMessage).toBe('refused by the connected-host boundary');
  });

  test('an edit the setting refuses says why and keeps what was typed', () => {
    selectFirst((entry) => entry.setting.type === 'number' && !isDaemonOwnedConfigKey(String(entry.setting.key)));
    modal.activateSelected();
    modal.editBuffer = 'abc';
    expect(modal.commitEdit()).toBe(false);
    expect(modal.lastSettingEffectMessage).toContain('not a number');
    expect(modal.editingMode).toBe(true);
    expect(modal.editBuffer).toBe('abc');
  });

  test('a reset whose write is refused is not copied into the live session', () => {
    select('provider.model');
    const key = 'provider.model' as const;
    const original = cm.setDynamic.bind(cm);
    cm.setDynamic = ((k: never, v: never) => {
      if (k === key) throw new Error('Setting provider.model is locked by managed policy');
      return original(k, v);
    }) as typeof cm.setDynamic;
    expect(modal.resetSelected()).toBeNull();
    expect(modal.lastSettingEffectMessage).toContain('Save failed');
  });
});
