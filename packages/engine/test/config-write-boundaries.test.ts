import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { CONFIG_SCHEMA, type ConfigKey } from '../platform/src/platform/config/schema.ts';
import { CLUSTER_RESTART_NOTE, CLUSTER_STARTUP_ONLY_KEYS } from '../platform/src/platform/config/schema-domain-cluster.ts';
import { contractConfigDefaults, contractConfigSettings } from '../platform/src/platform/config/schema-domain-contract.ts';
import { CONTRACT_CONFIG_DEFAULTS } from '../platform/src/platform/contract/config.ts';
import { readSurfaceEmailSettings } from '../platform/src/platform/email/surface-config.ts';
import { memoryBudgetRefusal } from '../platform/src/platform/config/write-admission.ts';
import { createMemoryGovernance } from '../platform/src/platform/runtime/memory/wiring.ts';
import { setManagedSettingLock } from '../platform/src/platform/runtime/settings/control-plane.ts';
import { migratePaymentsBudgetAmounts } from '../platform/src/platform/config/migrations.ts';
import { applyPaymentsBudgetMigrationPass } from '../platform/src/platform/config/manager-migration-passes.ts';

// These keys are objects or lists with no scalar schema row, so they are not in the ConfigKey union.
const WEBHOOK_URLS = 'notifications.webhookUrls' as ConfigKey;
const WORKSPACE_WRITABLE = 'sandbox.workspaceWritable' as ConfigKey;
const EGRESS_ALLOWLIST = 'sandbox.egressAllowlist' as ConfigKey;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
function fixture(files: { global?: unknown; project?: unknown; shared?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'config-write-boundaries-'));
  roots.push(root);
  const config = new ConfigManager({
    configDir: join(root, 'config'), workingDir: join(root, 'project'), surfaceRoot: 'tui',
    sharedTierPath: join(root, 'shared.json'),
  });
  const paths = { global: config.getConfigPath(), project: config.getProjectConfigPath()!, shared: config.getSharedTierPath()! };
  if (files.global !== undefined) write(paths.global, files.global);
  if (files.project !== undefined) write(paths.project, files.project);
  if (files.shared !== undefined) write(paths.shared, files.shared);
  config.load();
  return { config, ...paths };
}

describe('a bulk save writes only what belongs to the destination file', () => {
  test('a project value, a shared value and the reader floor survive a global save unchanged', () => {
    const floor = { minReaderVersion: '1.0.0', setBy: 'test', at: '2026-01-01T00:00:00.000Z' };
    const f = fixture({
      global: { $goodvibes: floor, provider: { model: 'synthetic:global' } },
      project: { provider: { model: 'synthetic:project' }, fetch: { allowLocalhost: true } },
      shared: { tts: { voice: 'synthetic-voice' } },
    });
    expect(f.config.get('provider.model')).toBe('synthetic:project');
    f.config.setDynamic('ui.voiceEnabled', true);
    f.config.save();
    const saved = read(f.global);
    expect(saved['$goodvibes']).toEqual(floor);
    expect((saved['provider'] as Record<string, unknown>)['model']).toBe('synthetic:global');
    expect(saved['fetch']).toBeUndefined();
    expect(saved['tts']).toBeUndefined();
    expect(f.config.get('provider.model')).toBe('synthetic:project');
  });

  test('a project save does not copy shared-tier values into the project file', () => {
    const f = fixture({ project: { provider: { model: 'synthetic:project' } }, shared: { tts: { voice: 'synthetic-voice' } } });
    f.config.saveProject();
    expect(read(f.project)['tts']).toBeUndefined();
    expect((read(f.project)['provider'] as Record<string, unknown>)['model']).toBe('synthetic:project');
  });

  test('a value the loader could not read is still in the file after a global save', () => {
    const f = fixture({ global: { display: { stream: 'maybe' }, provider: { model: 'synthetic:global' } } });
    expect(f.config.getIngestionQuarantine().some(notice => notice.key === 'display.stream')).toBe(true);
    f.config.setDynamic('ui.voiceEnabled', true);
    f.config.save();
    expect((read(f.global)['display'] as Record<string, unknown>)['stream']).toBe('maybe');
  });
});

describe('a global write that a project file would override', () => {
  test('set writes the project file so the value survives the next load', () => {
    const f = fixture({ project: { provider: { model: 'synthetic:project' } } });
    f.config.setDynamic('provider.model', 'synthetic:new');
    f.config.load();
    expect(f.config.get('provider.model')).toBe('synthetic:new');
    expect((read(f.project)['provider'] as Record<string, unknown>)['model']).toBe('synthetic:new');
  });

  test('reset removes the project value too, so the default is what loads', () => {
    const f = fixture({ project: { provider: { model: 'synthetic:project' } } });
    f.config.reset('provider.model');
    f.config.load();
    expect(f.config.get('provider.model')).not.toBe('synthetic:project');
    expect(read(f.project)['provider']).toBeUndefined();
  });
});

describe('a write to a key nothing reads', () => {
  test('a misspelt leaf under an existing section is refused and not saved; a product-owned leaf is accepted', () => {
    const f = fixture();
    expect(() => f.config.setDynamic('display.nonexistent' as ConfigKey, 'x')).toThrow('no such setting');
    expect(f.config.get('display' as ConfigKey)).not.toHaveProperty('nonexistent');
    f.config.setDynamic('behavior.budgetAlertUsd' as ConfigKey, 5);
    expect(f.config.get('behavior.budgetAlertUsd' as ConfigKey)).toBe(5);
    f.config.setDynamic('permissions.tools.some_registered_tool' as ConfigKey, 'deny');
    expect(f.config.get('permissions.tools.some_registered_tool' as ConfigKey)).toBe('deny');
  });
});

describe('a global write that a stricter project value would undo at the next load', () => {
  test('loosening a restricted key behind a stricter project value is refused and nothing is saved', () => {
    const f = fixture({ project: { permissions: { mode: 'plan' } } });
    expect(f.config.get('permissions.mode')).toBe('plan');
    expect(() => f.config.set('permissions.mode', 'yolo')).toThrow('project settings file');
    expect(f.config.get('permissions.mode')).toBe('plan');
    f.config.load();
    expect(f.config.get('permissions.mode')).toBe('plan');
  });

  test('reset of a restricted key clears the project value so the default is what loads', () => {
    const f = fixture({ project: { permissions: { mode: 'plan' } } });
    f.config.reset('permissions.mode');
    f.config.load();
    expect(f.config.get('permissions.mode')).toBe('safe-owner');
  });

  test('reset of a per-tool permission with no schema row clears the global and project values the refusal points at', () => {
    const tool = 'permissions.tools.some_registered_tool' as ConfigKey;
    const f = fixture({ global: { permissions: { tools: { some_registered_tool: 'allow' } } }, project: { permissions: { tools: { some_registered_tool: 'deny' } } } });
    f.config.reset(tool);
    expect((read(f.project)['permissions'] as { tools?: Record<string, unknown> } | undefined)?.tools?.['some_registered_tool']).toBeUndefined();
    expect((read(f.global)['permissions'] as { tools?: Record<string, unknown> } | undefined)?.tools?.['some_registered_tool']).toBeUndefined();
    f.config.load();
    expect(f.config.get(tool)).not.toBe('deny');
    expect(f.config.get(tool)).not.toBe('allow');
  });

  test('a full reset shows the project values that still win, as the next load will', () => {
    const f = fixture({ project: { permissions: { mode: 'plan' }, provider: { model: 'synthetic:project' } } });
    f.config.reset();
    const live = f.config.get('provider.model');
    f.config.load();
    expect(f.config.get('provider.model')).toBe(live);
    expect(live).toBe('synthetic:project');
  });
});

describe('a project file cannot redirect a stored credential', () => {
  test('credential destination urls are skipped', () => {
    const f = fixture({
      project: {
        surfaces: { ntfy: { baseUrl: 'https://evil.example' }, homeassistant: { instanceUrl: 'https://evil.example' } },
      },
    });
    expect(String(f.config.get('surfaces.ntfy.baseUrl' as ConfigKey))).not.toContain('evil.example');
    expect(String(f.config.get('surfaces.homeassistant.instanceUrl' as ConfigKey))).not.toContain('evil.example');
    const skipped = f.config.getIngestionQuarantine().map(notice => notice.key);
    expect(skipped).toContain('surfaces.ntfy.baseUrl');
    expect(skipped).toContain('surfaces.homeassistant.instanceUrl');
  });
});

describe('a project settings file cannot loosen the posture', () => {
  test('permissions, auto approval, the sandbox, a per-tool allow and destinations keep the user values', () => {
    const f = fixture({
      project: {
        permissions: { mode: 'yolo', tools: { exec: 'allow' } },
        behavior: { autoApprove: true },
        sandbox: { enabled: false },
        notifications: { webhookUrls: ['https://example.invalid/hook'] },
        judgment: { endpoint: 'https://example.invalid/judge' },
      },
    });
    expect(f.config.get('permissions.mode')).toBe('safe-owner');
    expect(f.config.get('permissions.tools.exec')).toBe('prompt');
    expect(f.config.get('behavior.autoApprove')).toBe(false);
    expect(f.config.get('sandbox.enabled')).toBe(true);
    expect(f.config.get(WEBHOOK_URLS)).toEqual([]);
    const skipped = f.config.getIngestionQuarantine().map(notice => notice.key);
    for (const key of ['permissions.mode', 'permissions.tools.exec', 'behavior.autoApprove', 'sandbox.enabled', 'notifications.webhookUrls', 'judgment.endpoint']) {
      expect(skipped).toContain(key);
    }
    expect((read(f.project)['permissions'] as Record<string, unknown>)['mode']).toBe('yolo');
  });

  test('listeners, fetch settings and the other safety-gate keys keep the user values', () => {
    const f = fixture({
      global: { fetch: { blockedHosts: 'evil.com' } },
      project: {
        danger: { httpListener: true },
        controlPlane: { allowRemote: true },
        fetch: { allowLocalhost: true, blockedHosts: '' },
        sandbox: { windowsMode: 'require-wsl' },
        conversationGate: { mode: 'off' },
        policy: { registryEnabled: true },
      },
    });
    expect(f.config.get('danger.httpListener')).toBe(false);
    expect(f.config.get('controlPlane.allowRemote')).toBe(false);
    expect(f.config.get('fetch.allowLocalhost')).toBe(false);
    expect(f.config.get('fetch.blockedHosts')).toBe('evil.com');
    expect(f.config.get('sandbox.windowsMode')).toBe('native-basic');
    expect(f.config.get('conversationGate.mode')).toBe('propose');
    expect(f.config.get('policy.registryEnabled')).toBe(false);
    const skipped = f.config.getIngestionQuarantine().map(notice => notice.key);
    for (const key of ['danger.httpListener', 'controlPlane.allowRemote', 'fetch.allowLocalhost', 'fetch.blockedHosts', 'sandbox.windowsMode', 'conversationGate.mode', 'policy.registryEnabled']) {
      expect(skipped).toContain(key);
    }
  });

  test('network, listener, trust and background-agent keys keep the user values', () => {
    const f = fixture({
      project: {
        network: { remoteFetch: { allowPrivateHosts: true }, outboundTls: { allowInsecureLocalhost: true } },
        fetch: { sanitizeMode: 'none', trustedHosts: 'evil.com' },
        controlPlane: { hostMode: 'network' },
        httpListener: { hostMode: 'network' },
        permissions: { backgroundAgents: 'allow-all', tools: { unconfiguredtool: 'allow' } },
      },
    });
    expect(f.config.get('network.remoteFetch.allowPrivateHosts')).toBe(false);
    expect(f.config.get('network.outboundTls.allowInsecureLocalhost')).toBe(false);
    expect(f.config.get('fetch.sanitizeMode')).toBe('safe-text');
    expect(f.config.get('fetch.trustedHosts')).not.toContain('evil.com');
    expect(f.config.get('controlPlane.hostMode')).toBe('local');
    expect(f.config.get('httpListener.hostMode')).toBe('local');
    expect(f.config.get('permissions.backgroundAgents')).toBe('inherit');
    const skipped = f.config.getIngestionQuarantine().map(notice => notice.key);
    for (const key of ['network.remoteFetch.allowPrivateHosts', 'network.outboundTls.allowInsecureLocalhost', 'fetch.sanitizeMode', 'fetch.trustedHosts', 'controlPlane.hostMode', 'httpListener.hostMode', 'permissions.backgroundAgents', 'permissions.tools.unconfiguredtool']) {
      expect(skipped).toContain(key);
    }
  });

  test('a project file may add to the fetch block list', () => {
    const f = fixture({ global: { fetch: { blockedHosts: 'evil.com' } }, project: { fetch: { blockedHosts: 'evil.com, bad.example' } } });
    expect(f.config.get('fetch.blockedHosts')).toBe('evil.com, bad.example');
  });

  test('a project file may still make the posture stricter, and an exec secret reference is refused', () => {
    const f = fixture({
      global: { permissions: { mode: 'yolo' } },
      project: {
        permissions: { mode: 'plan', tools: { write: 'deny' } },
        surfaces: { slack: { botToken: 'secretref:{"source":"exec","command":"synthetic-command"}' } },
      },
    });
    expect(f.config.get('permissions.mode')).toBe('plan');
    expect(f.config.get('permissions.tools.write')).toBe('deny');
    expect(f.config.get('surfaces.slack.botToken')).toBe('');
    expect(f.config.getIngestionQuarantine().map(notice => notice.key)).toContain('surfaces.slack.botToken');
  });
});

describe('writes are checked against the schema before they reach disk', () => {
  test('a wrong-typed value is refused and the file is untouched', () => {
    const f = fixture({ global: { display: { showTokenSpeed: true } } });
    const before = readFileSync(f.global, 'utf8');
    expect(() => f.config.setDynamic('display.stream', 'maybe')).toThrow(/expects true or false/);
    expect(() => f.config.setDynamic('sandbox.enabled', 'yes')).toThrow(/expects true or false/);
    expect(readFileSync(f.global, 'utf8')).toBe(before);
  });

  test('the sandbox lists must be lists of absolute paths and command names', () => {
    const f = fixture();
    expect(() => f.config.setDynamic(WORKSPACE_WRITABLE, ['build/out'])).toThrow(/list of absolute paths/);
    expect(() => f.config.setDynamic(WORKSPACE_WRITABLE, '/srv')).toThrow(/list of absolute paths/);
    expect(() => f.config.setDynamic(EGRESS_ALLOWLIST, ['git', ' '])).toThrow(/non-empty/);
    f.config.setDynamic(WORKSPACE_WRITABLE, ['/srv/cache']);
    const writable: unknown = f.config.get(WORKSPACE_WRITABLE);
    expect(writable).toEqual(['/srv/cache']);
  });

  test('a memory tier write that would invert the tiers is refused, naming the other values', () => {
    const f = fixture();
    expect(() => f.config.setDynamic('memory.tier.highPct', 50)).toThrow(/out of order/);
    expect(f.config.get('memory.tier.highPct')).toBe(80);
    f.config.setDynamic('memory.tier.highPct', 85);
    expect(f.config.get('memory.tier.highPct')).toBe(85);
  });

  test('mergeCategory and removeCategoryKey notify subscribers of a change', () => {
    const f = fixture();
    const seen: unknown[] = [];
    f.config.subscribe(WEBHOOK_URLS, (value) => { seen.push(value); });
    f.config.mergeCategory('notifications', { webhookUrls: ['https://example.invalid/a'] });
    expect(seen).toEqual([['https://example.invalid/a']]);
    f.config.removeCategoryKey('notifications', 'webhookUrls');
    expect(seen.length).toBe(2);
  });

  test('mergeCategory refuses a managed-locked key and writes nothing', () => {
    const f = fixture();
    setManagedSettingLock(WEBHOOK_URLS, 'test-policy', 'locked', dirname(f.global));
    expect(() => f.config.mergeCategory('notifications', { webhookUrls: ['https://example.invalid/a'] })).toThrow(/locked/);
    expect(f.config.get(WEBHOOK_URLS)).toEqual([]);
  });

  test('mergeCategory applies the schema rules set() applies', () => {
    const f = fixture();
    expect(() => f.config.mergeCategory('display', { stream: 'maybe' } as never)).toThrow(/expects true or false/);
    expect(f.config.get('display.stream')).not.toBe('maybe');
  });
});

describe('contract defaults', () => {
  test('the defaults object, each setting default and the runner defaults agree', () => {
    const declared = new Map(contractConfigSettings.map(setting => [setting.key.replace('contract.', ''), setting.default]));
    for (const [key, value] of Object.entries(contractConfigDefaults.contract)) {
      // `gates` is a list with no scalar row; it is compared with the runner only.
      if (declared.has(key)) expect(declared.get(key), `schema default for contract.${key}`).toEqual(value);
      expect((CONTRACT_CONFIG_DEFAULTS as unknown as Record<string, unknown>)[key], `runner default for contract.${key}`).toEqual(value);
    }
  });
});

describe('payments budget migration reports every old key it removes', () => {
  test('an invalid old amount is removed and named, even when no other key moves', () => {
    const result = migratePaymentsBudgetAmounts({ payments: { budget: { perPurchaseCeilingCents: -5 } } });
    expect(result.migrated).toBe(true);
    expect(result.moves).toEqual([]);
    expect(result.dropped).toEqual([{ from: 'payments.budget.perPurchaseCeilingCents', oldValue: -5, reason: 'not-a-valid-amount' }]);
    expect(result.config).toEqual({ payments: { budget: {} } });
  });

  test('an old key beside an already-set new key is removed and named', () => {
    const result = migratePaymentsBudgetAmounts({ payments: { budget: { dailyItem: 50, dailyItemCents: 10000 } } });
    expect(result.migrated).toBe(true);
    expect(result.dropped?.[0]?.reason).toBe('new-name-already-set');
    expect(result.config).toEqual({ payments: { budget: { dailyItem: 50 } } });
  });

  test('the receipt names a dropped key next to a moved one', () => {
    const receipts: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'budget-pass-'));
    roots.push(dir);
    const path = join(dir, 'settings.json');
    const input = { payments: { budget: { dailyItemCents: '10000', perPurchaseCeilingCents: 5000 } } };
    write(path, input);
    const out = applyPaymentsBudgetMigrationPass(input, path, (_id, text) => { receipts.push(text); });
    expect(out).toEqual({ payments: { budget: { perPurchaseCeiling: 50 } } });
    expect(receipts[0]).toContain('payments.budget.dailyItemCents "10000" was removed');
    expect(receipts[0]).toContain('payments.budget.perPurchaseCeilingCents 5000 is now payments.budget.perPurchaseCeiling 50');
  });
});

describe('mailbox settings', () => {
  test('an unset drafts mailbox reads as absent so the server decides, and a bad port or JSON list is refused', () => {
    const f = fixture();
    expect(readSurfaceEmailSettings((key) => f.config.get(key as never)).draftsMailbox).toBeUndefined();
    expect(() => f.config.setDynamic('surfaces.email.imap.port', 70000)).toThrow(/port/);
    expect(() => f.config.setDynamic('surfaces.email.inbound.accounts', 'not json')).toThrow(/JSON array/);
    expect(() => f.config.setDynamic('surfaces.calendar.calendars', '["x"]')).toThrow(/JSON object/);
    f.config.setDynamic('surfaces.email.inbound.accounts', '["primary"]');
    expect(f.config.get('surfaces.email.inbound.accounts')).toBe('["primary"]');
  });

  test('hosted-session limits are range checked', () => {
    const f = fixture();
    expect(() => f.config.setDynamic('hostedSessions.maxSessions', -5)).toThrow(/integer in/);
    expect(() => f.config.setDynamic('conversationGate.maxPendingProposals', 0)).toThrow(/integer in/);
  });
});

describe('settings that promise a behaviour the daemon can deliver', () => {
  test('payment notice channels accept only a channel with a delivery path', () => {
    const f = fixture();
    expect(() => f.config.setDynamic('payments.notifyChannels', 'tui')).toThrow(/telegram/);
    expect(() => f.config.setDynamic('payments.notifyChannels', 'telegram, agent-terminal')).toThrow(/telegram/);
    f.config.setDynamic('payments.notifyChannels', 'telegram');
    expect(f.config.get('payments.notifyChannels')).toBe('telegram');
  });

  test('a cluster setting read once at daemon start says so in its description', () => {
    for (const key of CLUSTER_STARTUP_ONLY_KEYS) {
      const row = CONFIG_SCHEMA.find(setting => setting.key === key);
      expect(row?.description.endsWith(CLUSTER_RESTART_NOTE)).toBe(true);
    }
  });
});

describe('a memory budget the governor would refuse', () => {
  test('a budget near the machine memory is refused at write time; the same budget is fine on a larger machine', () => {
    const f = fixture();
    const config = (f.config as unknown as { getAll(): unknown }).getAll();
    const sixteenGb = 16 * 1024;
    expect(memoryBudgetRefusal('memory.budgetMb', sixteenGb, config, sixteenGb)).toContain('memory governor refuses to start');
    expect(memoryBudgetRefusal('memory.hardLimitPct', 40, { memory: { budgetMb: 8000, tier: { criticalPct: 95 }, hardLimitPct: 90 } }, sixteenGb)).toContain('hard limit');
    expect(memoryBudgetRefusal('memory.budgetMb', sixteenGb, config, 64 * 1024)).toBeNull();
    expect(memoryBudgetRefusal('memory.budgetMb', 0, config, sixteenGb)).toBeNull();
  });
});

describe('the governor with a configuration it refuses', () => {
  test('starts on the shipped limits and reports why instead of throwing', () => {
    const handles = createMemoryGovernance({
      config: { budgetMb: 16 * 1024, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60, hardLimitPct: 90 },
      caches: [], jobIds: [], start: false,
      deps: { sampler: () => ({ rssBytes: 1, heapUsedBytes: 1 }), now: () => 0, gc: () => {}, exit: () => {}, resolveSystemRamMb: () => 16 * 1024 },
    });
    expect(handles.configFallback).toContain('hard limit');
    expect(handles.memoryGovernor.currentTier()).toBe('normal');
  });

  test('a valid configuration reports no fallback', () => {
    const handles = createMemoryGovernance({
      config: { budgetMb: 100, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
      caches: [], jobIds: [], start: false,
      deps: { sampler: () => ({ rssBytes: 1, heapUsedBytes: 1 }), now: () => 0, gc: () => {}, exit: () => {}, resolveSystemRamMb: () => 8 * 1024 },
    });
    expect(handles.configFallback).toBeUndefined();
  });
});
