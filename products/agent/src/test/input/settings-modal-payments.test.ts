/**
 * Tests for the payments settings category: money round-trips, the CVV
 * trade-off warning, the daemon.timezone picker dispatch, and the guard that
 * no settings surface ever renders a card-material-shaped value.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { ConfigManager, CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/platform/platform/payments';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-payments-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'agent',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-agent'),
  });
}

describe('SettingsModal payments category (no connected host: local fallback)', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let mcpRegistry: McpRegistry;
  let subscriptionManager: SubscriptionManager;
  let serviceRegistry: ServiceRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    ffm = createFeatureFlagManager();
    modal = new SettingsModal();
    subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'agent', 'subscriptions.json'));
    serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'agent'), { recursive: true });
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the payments category exists, is navigable, and lists every payments.* setting and one pointer to /payments card, with no card-material field', () => {
    expect(SETTINGS_CATEGORIES).toContain('payments');
    while (modal.currentCategory !== 'payments') modal.nextCategory();
    const keys = modal.currentItems.map((entry): string => entry.setting.key);
    expect(keys.sort()).toEqual([
      // Real CONFIG_SCHEMA keys
      'payments.billingAddress.city',
      'payments.billingAddress.country',
      'payments.billingAddress.line1',
      'payments.billingAddress.line2',
      'payments.billingAddress.name',
      'payments.billingAddress.postalCode',
      'payments.billingAddress.region',
      'payments.budget.dailyItem',
      'payments.budget.dailyOverage',
      'payments.budget.overageToleranceDailyAllowance',
      'payments.budget.overageToleranceEnabled',
      'payments.budget.perPurchaseCeiling',
      'payments.budget.perPurchaseCeilingEnabled',
      'payments.confirmEveryPurchase',
      'payments.currency',
      'payments.cvvHandling',
      'payments.defaultCardId',
      'payments.ebayMinSellerFeedbackCount',
      'payments.ebayMinSellerPositivePercent',
      'payments.enabled',
      'payments.majorRetailersAdditional',
      'payments.majorRetailersExcluded',
      'payments.notifyChannels',
      'payments.shipping.preferredTier',
      'payments.shippingAddress.city',
      'payments.shippingAddress.country',
      'payments.shippingAddress.line1',
      'payments.shippingAddress.line2',
      'payments.shippingAddress.name',
      'payments.shippingAddress.postalCode',
      'payments.shippingAddress.region',
      'payments.windows.approvalMinutes',
      'payments.windows.vetoMinutes',
      // Cards are not settings: one locked row points to /payments card.
      'payments.cardsOnFile',
    ].sort());
  });

  describe('money fields round-trip exactly, as the plain amount typed', () => {
    // platform 2.0.5 dropped the Cents suffix and the minor-unit storage: the
    // config now holds exactly the number a person typed ("19.99" stores as
    // 19.99, not 1999), so there is no cent-rounding math left to prove here
    //, only that the value survives the edit buffer unchanged.
    test.each(['0.1', '0.29', '19.99', '1234.56'])('typing %s stores that exact amount and re-editing shows it back', (typed) => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.budget.dailyItem');
      modal.activateSelected();
      expect(modal.editingMode).toBe(true);
      // The edit buffer opens on the raw stored default (0), not a
      // currency-formatted string, there is no unit to format for anymore.
      expect(modal.editBuffer).toBe('0');

      modal.editBuffer = typed;
      expect(modal.commitEdit()).toBe(true);
      expect(cm.get('payments.budget.dailyItem')).toBe(Number(typed));

      // Re-opening the field for edit shows the same value back.
      modal.activateSelected();
      expect(modal.editBuffer).toBe(typed);
      modal.cancelEdit();
    });

    // Every other payments.budget.* amount key drives the identical path,
    // but each gets its own assertion here rather than inheriting
    // dailyItem's, a wrong key name on any one of these would silently
    // read/write the wrong config path and only its own test would catch it.
    test.each([
      ['payments.budget.dailyOverage', '0.29'],
      ['payments.budget.perPurchaseCeiling', '19.99'],
      ['payments.budget.overageToleranceDailyAllowance', '1234.56'],
    ])('%s: typing %s stores exactly that amount', (key, typed) => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === key);
      modal.activateSelected();
      expect(modal.editBuffer).toBe('0');
      modal.editBuffer = typed as string;
      expect(modal.commitEdit()).toBe(true);
      expect(cm.get(key as 'payments.budget.dailyOverage')).toBe(Number(typed));
    });
  });

  describe('payments keys that are NOT money keep their plain numeric form', () => {
    // These four are counts and minutes, never amounts of payments.currency,
    // config/payments-money-format.ts's isMoneyConfigKey would say so for
    // any of them, since none carries the schema's `unit: 'money'` mark. The
    // edit/commit path treats every number setting identically now (money or
    // not), so this mainly guards against a wrong key name silently reading
    // or writing the wrong config path. Each key is driven to two distinct
    // values so that failure mode shows up on the specific key, not masked by
    // its neighbours.
    test.each([
      ['payments.windows.approvalMinutes', 60, '45', 45, '90', 90],
      ['payments.windows.vetoMinutes', 10, '5', 5, '30', 30],
      ['payments.ebayMinSellerFeedbackCount', 100, '250', 250, '25', 25],
      ['payments.ebayMinSellerPositivePercent', 98, '99', 99, '90', 90],
    ])('%s edits as a plain number and stores %d -> %s -> %s', (key, initial, firstTyped, firstStored, secondTyped, secondStored) => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      const configKey = key as 'payments.windows.approvalMinutes';
      expect(cm.get(configKey)).toBe(initial as number);

      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === key);
      modal.activateSelected();
      expect(modal.editingMode).toBe(true);
      expect(modal.editBuffer).toBe(String(initial));

      modal.editBuffer = firstTyped as string;
      expect(modal.commitEdit()).toBe(true);
      expect(cm.get(configKey)).toBe(firstStored as number);

      // A second, different value through the same path, so this is a test of
      // the conversion rule and not of one lucky number.
      modal.activateSelected();
      expect(modal.editBuffer).toBe(String(firstStored));
      modal.editBuffer = secondTyped as string;
      expect(modal.commitEdit()).toBe(true);
      expect(cm.get(configKey)).toBe(secondStored as number);
    });
  });

  test('payments.shipping.preferredTier cycles through the tiers the schema declares', () => {
    while (modal.currentCategory !== 'payments') modal.nextCategory();
    const declared = CONFIG_SCHEMA.find((entry) => entry.key === 'payments.shipping.preferredTier')?.enumValues ?? [];
    expect(declared).toEqual(['normal', 'fast', 'fastest']);
    expect(cm.get('payments.shipping.preferredTier')).toBe('normal');

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.shipping.preferredTier');
    modal.activateSelected();
    const afterFirst = cm.get('payments.shipping.preferredTier');
    expect(afterFirst).not.toBe('normal');
    expect(declared).toContain(afterFirst);

    modal.activateSelected();
    const afterSecond = cm.get('payments.shipping.preferredTier');
    expect(afterSecond).not.toBe(afterFirst);
    expect(declared).toContain(afterSecond);

    // All the way round: the cycle is bounded by the declared set rather than
    // walking off it, which is what makes an unrecognised tier impossible to
    // store from this screen.
    modal.activateSelected();
    expect(cm.get('payments.shipping.preferredTier')).toBe('normal');
  });

  test('payments.enabled toggles both ways from this screen', () => {
    while (modal.currentCategory !== 'payments') modal.nextCategory();
    expect(cm.get('payments.enabled')).toBe(false);

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.enabled');
    modal.activateSelected();
    expect(cm.get('payments.enabled')).toBe(true);

    // And back, a toggle that only ever turns something ON is a switch the
    // owner cannot undo where he found it.
    modal.activateSelected();
    expect(cm.get('payments.enabled')).toBe(false);
  });

  test('a non-numeric or negative money entry is rejected, not silently coerced', () => {
    while (modal.currentCategory !== 'payments') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.budget.dailyItem');
    modal.activateSelected();
    modal.editBuffer = '-5';
    expect(modal.commitEdit()).toBe(false);
    expect(cm.get('payments.budget.dailyItem')).toBe(0);
  });

  test('changing payments.currency has no effect on a money field\'s edit buffer or stored value', () => {
    // platform 2.0.5 removed the currency-dependent minor-unit conversion this
    // used to prove (JPY's zero-decimal exponent used to change what "500"
    // meant). A money key's value is now the plain number typed, independent
    // of payments.currency, so switching to JPY changes nothing about it,
    // including that a two-decimal amount still stores exactly as typed.
    while (modal.currentCategory !== 'payments') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.currency');
    modal.activateSelected();
    modal.editBuffer = 'JPY';
    expect(modal.commitEdit()).toBe(true);

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.budget.dailyItem');
    modal.activateSelected();
    expect(modal.editBuffer).toBe('0');
    modal.editBuffer = '500.25';
    expect(modal.commitEdit()).toBe(true);
    expect(cm.get('payments.budget.dailyItem')).toBe(500.25);
  });

  test('selecting daemon.timezone dispatches the picker instead of free-text edit', () => {
    while (modal.currentCategory !== 'daemon') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'daemon.timezone');
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction).toBe('daemon-timezone');
    expect(modal.editingMode).toBe(false);
  });

  describe('CVV trade-off warning', () => {
    test('selecting prompt surfaces the exact platform warning string', () => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.cvvHandling');
      expect(modal.getSelected()?.currentValue).toBe('stored');
      expect(modal.lastSettingEffectMessage).toBeNull();

      modal.activateSelected(); // cycles the enum: stored -> prompt
      expect(cm.get('payments.cvvHandling')).toBe('prompt');
      expect(modal.lastSettingEffectMessage).toBe(CVV_PROMPT_TRADEOFF_WARNING);
    });

    test('switching back to stored shows no warning of any kind', () => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.cvvHandling');
      modal.activateSelected(); // -> prompt
      modal.activateSelected(); // -> stored
      expect(cm.get('payments.cvvHandling')).toBe('stored');
      expect(modal.lastSettingEffectMessage).toBeNull();
    });
  });

});

describe('SettingsModal payments category (connected host owns payments.*)', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let modal: SettingsModal;
  let stored: Map<string, unknown>;
  let sets: Array<{ key: string; value: unknown }>;
  let failWith: Error | null;
  let rendered: () => void;

  /** Resolves when the host's answer (not the in-flight notice) has been shown. */
  const hostAnswered = (): Promise<void> => new Promise((resolve) => { rendered = resolve; });

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    stored = new Map();
    sets = [];
    failWith = null;
    rendered = () => {};
    installAgentDaemonConfigClient({
      ownsKey: (key: string) => key.startsWith('payments.'),
      set: async (key: string, value: unknown) => {
        sets.push({ key, value });
        if (failWith) throw failWith;
        stored.set(key, value);
      },
      get: async (key: string) => stored.get(key),
      snapshot: async () => null,
    });
    const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'agent', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    mkdirSync(join(tmpDir, '.goodvibes', 'agent'), { recursive: true });
    modal = new SettingsModal();
    modal.open(cm, createFeatureFlagManager(), subscriptionManager, serviceRegistry,
      { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry,
      undefined, { requestRender: () => {
        if (modal.lastSettingEffectMessage?.startsWith('Saving on the connected host')) return;
        rendered();
      } });
    while (modal.currentCategory !== 'payments') modal.nextCategory();
  });

  afterEach(() => {
    installAgentDaemonConfigClient(null);
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function select(key: string): void {
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === key);
  }

  test('a toggle is written to the host, not the local file, and the row shows what the host holds', async () => {
    select('payments.enabled');
    const answered = hostAnswered();
    modal.activateSelected();
    expect(modal.lastSettingEffectMessage).toContain('Saving on the connected host');
    await answered;
    expect(sets).toEqual([{ key: 'payments.enabled', value: true }]);
    expect(cm.get('payments.enabled')).toBe(false);
    expect(modal.getSelected()?.currentValue).toBe(true);
    expect(modal.lastSettingEffectMessage).toContain('Applied by the connected host');
  });

  test('a money amount is sent to the host as the number typed and shown back as the host stores it', async () => {
    select('payments.budget.dailyItem');
    modal.activateSelected();
    modal.editBuffer = '19.99';
    const answered = hostAnswered();
    expect(modal.commitEdit()).toBe(true);
    await answered;
    expect(sets).toEqual([{ key: 'payments.budget.dailyItem', value: 19.99 }]);
    expect(cm.get('payments.budget.dailyItem')).toBe(0);
    expect(modal.getSelected()?.currentValue).toBe(19.99);
  });

  test('what the host holds wins over what was sent when it clamps the value', async () => {
    stored.set('payments.windows.approvalMinutes', 15);
    const original = (key: string, value: unknown) => { sets.push({ key, value }); };
    installAgentDaemonConfigClient({
      ownsKey: (key: string) => key.startsWith('payments.'),
      set: async (key: string, value: unknown) => { original(key, value); },
      get: async () => 15,
      snapshot: async () => null,
    });
    select('payments.windows.approvalMinutes');
    modal.activateSelected();
    modal.editBuffer = '600';
    const answered = hostAnswered();
    expect(modal.commitEdit()).toBe(true);
    await answered;
    expect(sets).toEqual([{ key: 'payments.windows.approvalMinutes', value: 600 }]);
    expect(modal.getSelected()?.currentValue).toBe(15);
  });

  test('a refusal from the host is reported, nothing is written locally and the row keeps its value', async () => {
    failWith = new Error('host unreachable');
    select('payments.enabled');
    const answered = hostAnswered();
    modal.activateSelected();
    await answered;
    expect(modal.lastSettingEffectMessage).toBe('Save failed: host unreachable');
    expect(cm.get('payments.enabled')).toBe(false);
    expect(modal.getSelected()?.currentValue).toBe(false);
  });

  test('a second change to a key still being saved is refused until the host answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    installAgentDaemonConfigClient({
      ownsKey: (key: string) => key.startsWith('payments.'),
      set: async (key: string, value: unknown) => { sets.push({ key, value }); await gate; },
      get: async () => true,
      snapshot: async () => null,
    });
    select('payments.enabled');
    modal.activateSelected();
    modal.activateSelected();
    expect(modal.lastSettingEffectMessage).toContain('still being saved on the connected host');
    expect(sets).toHaveLength(1);
    const answered = hostAnswered();
    release();
    await answered;
  });
});
