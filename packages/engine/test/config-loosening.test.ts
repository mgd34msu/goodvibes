/**
 * An agent cannot loosen security through settings: a write that widens the
 * sandbox or loosens any payments key is refused unless the owner, his rule or
 * the mode settled the call, and nothing is saved. Every key under the
 * security-bearing prefixes is classified, so a new key there is a decision
 * someone made, not a gap.
 *
 * Real ConfigManager over a temp directory, real config-key facts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, type WriteOrigin } from '../platform/src/platform/config/manager.ts';
import { CONFIG_KEYS, type ConfigKey } from '../platform/src/platform/config/schema.ts';
import { configKeyFacts } from '../platform/src/platform/config/config-key-facts.ts';
import { SAFETY_GATE_CONFIG_PREFIXES } from '../platform/src/platform/config/settings-ingestion.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-config-loosening-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const owner: WriteOrigin = { kind: 'owner', surface: 'fixture' };
const agent = (decision?: Extract<WriteOrigin, { kind: 'agent' }>['decision']): WriteOrigin => ({ kind: 'agent', surface: 'fixture', decision });
/** Who may not loosen: an agent with no decision, and one Jev allowed. */
const UNSETTLED: readonly WriteOrigin[] = [agent(), agent({ state: 'allowed-by-jev', decidedBy: 'jev', reason: 'fixture' })];

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
];

test('an agent write that widens the sandbox or loosens a payments key is refused and nothing is saved', () => {
  const config = manager();
  const baseline = LOOSENING.filter((row) => row.baseline !== undefined).map((row) => ({ key: row.key as ConfigKey, value: row.baseline }));
  expect(config.setMany(baseline, owner).ok).toBe(true);
  const before = new Map(LOOSENING.map((row) => [row.key, config.get(row.key as ConfigKey)]));
  const revision = config.revisionSource.revision();
  for (const row of LOOSENING) {
    for (const by of UNSETTLED) {
      const result = config.setMany([{ key: row.key as ConfigKey, value: row.value }], by);
      const code = result.ok ? 'saved' : result.refusal.code;
      expect(`${row.key} by ${by.kind === 'agent' ? by.decision?.decidedBy ?? 'agent' : by.kind}: ${code}`)
        .toBe(`${row.key} by ${by.kind === 'agent' ? by.decision?.decidedBy ?? 'agent' : by.kind}: OWNER_ONLY`);
    }
  }
  // Several together are refused whole.
  expect(config.setMany(LOOSENING.slice(0, 3).map((row) => ({ key: row.key as ConfigKey, value: row.value })), agent()).ok).toBe(false);
  expect(config.revisionSource.revision()).toBe(revision);
  const disk = reopened();
  for (const row of LOOSENING) {
    expect(config.get(row.key as ConfigKey)).toEqual(before.get(row.key));
    expect(disk.get(row.key as ConfigKey)).toEqual(before.get(row.key));
  }
});

test('the owner, or an agent call the owner settled, may make the same change; tightening needs no one', () => {
  const config = manager();
  expect(config.setMany([{ key: 'sandbox.egressAllowlist' as ConfigKey, value: ['curl', 'git'] }], agent({ state: 'allowed', decidedBy: 'owner', reason: 'fixture' })).ok).toBe(true);
  expect(config.get('sandbox.egressAllowlist' as ConfigKey)).toEqual(['curl', 'git']);
  expect(config.setMany([{ key: 'sandbox.egressAllowlist' as ConfigKey, value: ['git'] }], agent()).ok).toBe(true);
  expect(config.setMany([{ key: 'payments.budget.perPurchaseCeiling' as ConfigKey, value: 5000 }], owner).ok).toBe(true);
  expect(config.setMany([{ key: 'payments.budget.perPurchaseCeiling' as ConfigKey, value: 100 }], agent()).ok).toBe(true);
  expect(reopened().get('payments.budget.perPurchaseCeiling' as ConfigKey)).toBe(100);
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
