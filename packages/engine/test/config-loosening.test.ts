// Proves: A credential is stored as a literal in a settings file, card material reaches one, or a refusal echoes the value.
// Red when: A credential literal or card material is accepted into a settings file, or the refusal echoes the value.
// Proves: An agent loosens the sandbox, a payments limit or the permission mode through a settings write that neither the owner, their rule nor the mode settled.
// Red when: `ConfigManager.setMany` saves a loosening change from an agent with no decision or with only Jev's, saves part of a refused update, or a new key under a security prefix has neither a loosening rule nor a review.
// Proves: A setting locked as managed in the daemon's folder or another program's is written through the daemon's settings.
// Red when: The daemon's settings manager reads managed locks only from its own folder, so a lock kept beside the daemon's settings file, beside its own client settings or in the Agent's folder lets the write through.
/**
 * An agent cannot loosen security through settings: a write that widens the
 * sandbox or loosens any payments key is refused unless the owner, their rule or
 * the mode settled the call, and nothing is saved. Every key under the
 * security-bearing prefixes is classified, so a new key there is a decision
 * someone made, not a gap.
 *
 * Real ConfigManager over a temp directory, real config-key facts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, type ConfigSetOptions } from '../platform/src/platform/config/manager.ts';
import { agentActor, localOwnerActor, type Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { CONFIG_KEYS, type ConfigKey } from '../platform/src/platform/config/schema.ts';
import { configKeyFacts } from '../platform/src/platform/config/config-key-facts.ts';
import { SAFETY_GATE_CONFIG_PREFIXES } from '../platform/src/platform/config/settings-ingestion.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-config-loosening-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const owner: Actor = localOwnerActor();
/** A model acting in the owner's turn, as the runtime builds it. */
const agent: Actor = agentActor(owner);
/** Who may not loosen: an agent with no decision, and one Jev allowed. */
const UNSETTLED: readonly { readonly name: string; readonly options: ConfigSetOptions }[] = [
  { name: 'agent', options: {} },
  { name: 'jev', options: { decision: { state: 'allowed-by-jev', decidedBy: 'jev', reason: 'fixture' } } },
];

function manager(): ConfigManager {
  return new ConfigManager({ configDir: join(dir, 'surface'), daemonTierPath: join(dir, 'daemon', 'settings.json'), ownsDaemonTier: true });
}
/** The same files read by a second manager, as the next start reads them. */
function reopened(): ConfigManager {
  return new ConfigManager({ configDir: join(dir, 'surface'), daemonTierPath: join(dir, 'daemon', 'settings.json') });
}

/** One loosening write per key: the owner's strict baseline first, then the agent's change. */
const LOOSENING: readonly { readonly key: string; readonly baseline?: unknown; readonly value: unknown }[] = [
  { key: 'sandbox.enabled', baseline: true, value: false },
  { key: 'sandbox.egressAllowlist', baseline: [], value: ['curl'] },
  { key: 'sandbox.workspaceWritable', baseline: [], value: ['/home/owner/.ssh'] },
  { key: 'sandbox.judgment', baseline: 'annotate', value: 'auto-approve' },
  { key: 'payments.enabled', baseline: false, value: true },
  { key: 'payments.confirmEveryPurchase', baseline: true, value: false },
  { key: 'payments.cvvHandling', baseline: 'prompt', value: 'stored' },
  { key: 'payments.defaultCardId', value: 'card-attacker' },
  { key: 'payments.budget.perPurchaseCeiling', baseline: 1000, value: 900000 },
  { key: 'payments.budget.perPurchaseCeilingEnabled', baseline: true, value: false },
  { key: 'payments.budget.dailyItem', baseline: 1000, value: 900000 },
  { key: 'payments.budget.dailyOverage', baseline: 100, value: 900000 },
  { key: 'payments.budget.overageToleranceEnabled', baseline: false, value: true },
  { key: 'payments.budget.overageToleranceDailyAllowance', baseline: 100, value: 900000 },
  { key: 'payments.windows.vetoMinutes', baseline: 30, value: 1 },
  { key: 'payments.majorRetailersAdditional', value: 'attacker-shop.example' },
  { key: 'payments.majorRetailersExcluded', baseline: 'excluded.example', value: '' },
  { key: 'payments.ebayMinSellerFeedbackCount', baseline: 100, value: 0 },
  { key: 'payments.ebayMinSellerPositivePercent', baseline: 98, value: 0 },
  { key: 'payments.notifyChannels', value: 'telegram' },
  { key: 'payments.currency', baseline: 'USD', value: 'GBP' },
  { key: 'payments.shippingAddress.line1', baseline: '1 Owner Street', value: '9 Drop Lane' },
  { key: 'payments.shippingAddress.postalCode', baseline: '10001', value: '99999' },
  { key: 'permissions.mode', baseline: 'ask-me', value: 'yolo' },
  // Midnight in Pago Pago falls eleven hours after midnight UTC: the daily limits would restart on another clock.
  { key: 'daemon.timezone', baseline: 'UTC', value: 'Pacific/Pago_Pago' },
];

test('an agent write that widens the sandbox or loosens a payments key is refused and nothing is saved', () => {
  const config = manager();
  const baseline = LOOSENING.filter((row) => row.baseline !== undefined).map((row) => ({ key: row.key as ConfigKey, value: row.baseline }));
  expect(config.setMany(baseline, owner).ok).toBe(true);
  const before = new Map(LOOSENING.map((row) => [row.key, config.get(row.key as ConfigKey)]));
  const revision = config.revisionSource.revision();
  for (const row of LOOSENING) {
    for (const by of UNSETTLED) {
      const result = config.setMany([{ key: row.key as ConfigKey, value: row.value }], agent, by.options);
      const code = result.ok ? 'saved' : result.refusal.code;
      expect(`${row.key} by ${by.name}: ${code}`).toBe(`${row.key} by ${by.name}: OWNER_ONLY`);
    }
  }
  // Several together are refused whole.
  expect(config.setMany(LOOSENING.slice(0, 3).map((row) => ({ key: row.key as ConfigKey, value: row.value })), agent).ok).toBe(false);
  expect(config.revisionSource.revision()).toBe(revision);
  const disk = reopened();
  for (const row of LOOSENING) {
    const saved: unknown = before.get(row.key);
    expect(config.get(row.key as ConfigKey) as unknown).toEqual(saved);
    expect(disk.get(row.key as ConfigKey) as unknown).toEqual(saved);
  }
});

/** The prefixes whose keys guard what an agent may do, spend or reach. */
const SECURITY_PREFIXES: readonly string[] = [
  'sandbox.', 'payments.', 'permissions.',
  // The safety-gate keys as the settings module declares them; the judgment
  // backend is a project's own choice and is held by the loader instead.
  ...SAFETY_GATE_CONFIG_PREFIXES.filter((prefix) => !prefix.startsWith('judgment.') && prefix !== 'provider.decisionRouter'),
];

/**
 * Keys under those prefixes that loosen nothing, each with why. A key added
 * under a security prefix fails the test below until it is either given a
 * loosening rule in config-key-facts.ts or reviewed onto this list.
 */
const REVIEWED_NOT_LOOSENING: Readonly<Record<string, string>> = {
  'payments.billingAddress.name': 'card verification detail; moves no money and redirects no delivery',
  'payments.billingAddress.line1': 'card verification detail',
  'payments.billingAddress.line2': 'card verification detail',
  'payments.billingAddress.city': 'card verification detail',
  'payments.billingAddress.region': 'card verification detail',
  'payments.billingAddress.postalCode': 'card verification detail',
  'payments.billingAddress.country': 'card verification detail',
  'payments.shipping.preferredTier': 'a faster tier draws on the overage budget, which keeps its own limit',
  'payments.windows.approvalMinutes': 'silence denies an above-budget purchase, so a longer wait approves nothing',
  'permissions.simulation': 'records divergence beside enforcement and never changes it',
  'permissions.divergenceDashboard': 'display of divergence records',
  'permissions.divergenceThreshold': 'when divergence is reported',
  'permissions.maxDivergenceRecords': 'how many divergence records are kept',
};

test('every key under a security prefix is classified: it has a loosening rule, is protected material, or was reviewed', () => {
  const unclassified: string[] = [];
  const stale: string[] = [];
  for (const key of [...CONFIG_KEYS].sort()) {
    if (!SECURITY_PREFIXES.some((prefix) => (prefix.endsWith('.') ? key.startsWith(prefix) : key === prefix))) continue;
    const facts = configKeyFacts(key);
    const reviewed = Object.hasOwn(REVIEWED_NOT_LOOSENING, key);
    if (facts.loosens !== undefined || facts.cardMaterial || facts.secret) { if (reviewed) stale.push(key); continue; }
    if (!reviewed) unclassified.push(key);
  }
  expect(unclassified).toEqual([]);
  expect(stale).toEqual([]);
  for (const key of Object.keys(REVIEWED_NOT_LOOSENING)) expect(`${key} in schema: ${CONFIG_KEYS.has(key)}`).toBe(`${key} in schema: true`);
});

/** A managed lock as an administrator or a program's "Lock a setting" keeps it: `<folder>/settings-sync.json`. */
function lockIn(folder: string, key: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'settings-sync.json'), JSON.stringify({ version: 2, events: [], failures: [], syncedSettings: [], managedSettings: [], conflicts: [], rollbackHistory: [],
    managedLocks: [{ key, source: 'the security team', reason: 'set by policy', updatedAt: 1 }] }));
}

test('a setting locked in the daemon folder or in another program folder is refused by the daemon settings and stays unchanged', () => {
  // The daemon's settings manager as its start builds it (products/daemon cli/configuration.ts): the terminal app's
  // state folder as its own, its client settings in daemon-host, its daemon-owned settings in the daemon home.
  const home = dir;
  const daemonHome = join(home, '.goodvibes', 'daemon');
  const daemon = (): ConfigManager => new ConfigManager({ homeDir: home, surfaceRoot: 'tui', settingsSurfaceRoot: 'daemon-host',
    daemonTierPath: join(daemonHome, 'settings.json'), ownsDaemonTier: true });
  const key = 'behavior.budgetAlertUsd' as ConfigKey;
  const where: readonly { readonly name: string; readonly folder: string }[] = [
    { name: 'the daemon\'s own folder', folder: daemonHome },
    { name: 'the daemon\'s client folder', folder: join(home, '.goodvibes', 'daemon-host') },
    { name: 'the Agent\'s folder', folder: join(home, '.goodvibes', 'agent') },
  ];
  let value = 10;
  for (const place of where) {
    lockIn(place.folder, key);
    const config = daemon();
    const before = config.get(key);
    const many = config.setMany([{ key, value: ++value }], owner);
    expect(`${place.name}: ${many.ok ? 'saved' : `${many.refusal.code} ${many.refusal.reason}`}`)
      .toBe(`${place.name}: CONFIG_MANAGED ${key} is locked as managed by the security team (set by policy), so it was not changed. Only the owner removes the lock: Tools and extensions, Managed settings, unlock (it is kept in ${join(place.folder, 'settings-sync.json')}).`);
    expect(() => config.set(key, ++value as never)).toThrow('locked as managed by the security team');
    expect(`${place.name}: ${String(daemon().get(key))}`).toBe(`${place.name}: ${String(before)}`);
    // Control: the lock removed, the same write is saved.
    rmSync(join(place.folder, 'settings-sync.json'));
    expect(`${place.name} unlocked: ${daemon().setMany([{ key, value: ++value }], owner).ok}`).toBe(`${place.name} unlocked: true`);
    expect(daemon().get(key)).toBe(value as never);
  }
});

/** A manager over its own temp directory, for a case that reads the daemon tier file itself. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'config-set-many-'));
  const configDir = join(root, 'surface');
  const daemonTierPath = join(root, 'daemon', 'settings.json');
  const manager = new ConfigManager({ configDir, daemonTierPath, ownsDaemonTier: true });
  return { manager, configDir, daemonTierPath, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('a credential is kept only as a reference, card material never reaches a settings file, and no value is echoed', () => {
  const f = fixture();
  try {
    const literal = f.manager.setMany([{ key: 'surfaces.slack.botToken' as ConfigKey, value: 'fixture-private-token' }], owner);
    const card = f.manager.setMany([{ key: 'payments.cardNumber' as ConfigKey, value: 'fixture-private-card' }], owner);
    for (const [result, code] of [[literal, 'CONFIG_SECRET_LITERAL'], [card, 'CONFIG_CARD_MATERIAL']] as const) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe(code);
        expect(JSON.stringify(result.refusal)).not.toContain('fixture-private');
      }
    }
    expect(existsSync(f.daemonTierPath)).toBe(false);
    const reference = 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN';
    expect(f.manager.setMany([{ key: 'surfaces.slack.botToken' as ConfigKey, value: reference }], owner).ok).toBe(true);
    expect(readFileSync(f.daemonTierPath, 'utf8')).toContain(reference);
  } finally { f.close(); }
});
