import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createDaemonContinuationPolicy } from '../../runtime/native-continuation-policy.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('continuation-policy'), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const options = { workingDir: workspace, homeDir: root, configDir: join(root, 'config'), surfaceRoot: 'daemon' };
  const configuration = new ConfigManager(options);
  let scopeRevision = 'original-workspace-policy';
  let scopes: readonly string[] = ['read:work-ledger', 'write:work-ledger'];
  const owner = { current: () => ({ revision: scopeRevision, scopes }) };
  const policy = createDaemonContinuationPolicy(configuration, owner);
  return { root, configuration, owner, policy, restart: () => new ConfigManager(options),
    changeScope: (revision: string, nextScopes = scopes) => { scopeRevision = revision; scopes = nextScopes; } };
}

test('fresh CI2 policy is hash-free while actual saved CI1 expectations retain their verifier', () => {
  let configuration = 'opaque-configuration-original', scope = 'opaque-scope-original';
  const original = { captureDurableConfigurationIncarnation: () => configuration, getDurableConfigurationIncarnation: () => configuration, onDidChangeIncarnation: (_listener: () => void) => () => {} };
  const selected = { current: () => ({ revision: scope, scopes: ['read:work-ledger'] }) }, policy = createDaemonContinuationPolicy(original, selected);
  const expectedLegacy = createHash('sha256').update(JSON.stringify([configuration, scope])).digest('hex');
  const hash = spyOn(crypto, 'createHash'), count = () => hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256').length;
  try {
    const issued = policy.capture(2); expect(issued).toBe(JSON.stringify([configuration, scope]));
    for (let i = 0; i < 20; i++) expect(policy.current(2)).toBe(issued);
    expect(count()).toBe(0);
    const legacy = policy.current(1); expect(legacy).toBe(expectedLegacy); expect(count()).toBe(1);
    expect(() => policy.capture(1)).toThrow('fresh issuance');
    for (let i = 0; i < 20; i++) expect(policy.current(1)).toBe(legacy);
    expect(count()).toBe(1);
    configuration = 'opaque-configuration-next'; scope = 'opaque-scope-next'; expect(policy.current(2)).not.toBe(issued);
    const successor = policy.capture(2); expect(successor).toBe(JSON.stringify([configuration, scope])); expect(count()).toBe(1);
    expect(policy.current(1)).not.toBe(expectedLegacy); expect(count()).toBe(2);
    expect(createDaemonContinuationPolicy(original, selected).current(2)).toBe(successor);
  } finally { hash.mockRestore(); }
});

test('current live checks preserve the exact newly issued native CI2 tuple', () => {
  const f = fixture(), binding = f.policy.capture();
  const expected = JSON.stringify([f.configuration.getDurableConfigurationIncarnation(), f.owner.current().revision]);
  expect(binding).toBe(expected);
  for (let i = 0; i < 20; i++) expect(f.policy.current()).toBe(binding);
  expect(f.policy.capture()).toBe(binding);
  expect(f.policy.scopes()).toEqual(['read:work-ledger', 'write:work-ledger']);
});

test('a restarted owner recovers the original persisted binding from actual durable revisions', () => {
  const f = fixture(), path = join(f.root, 'issued-policy.json');
  writeFileSync(path, JSON.stringify({ policyRevision: f.policy.capture() }));
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { policyRevision: string };
  const reopened = createDaemonContinuationPolicy(f.restart(), f.owner);
  // Recovery observes; it does not establish new configuration history.
  expect(reopened.current()).toBe(saved.policyRevision);
  expect(reopened.current()).toBe(saved.policyRevision);
});

test('an actual saved CI1 binding survives unchanged restart and refuses changed policy', () => {
  const f = fixture(); f.configuration.captureDurableConfigurationIncarnation();
  const expected = createHash('sha256').update(JSON.stringify([f.configuration.getDurableConfigurationIncarnation(1), f.owner.current().revision])).digest('hex');
  const path = join(f.root, 'saved-ci1-policy.json'); writeFileSync(path, JSON.stringify({ policyRevision: expected }));
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { policyRevision: string };
  const reopened = createDaemonContinuationPolicy(f.restart(), f.owner);
  expect(reopened.current(1)).toBe(saved.policyRevision);
  f.changeScope('changed-workspace-policy'); expect(reopened.current(1)).not.toBe(saved.policyRevision);
  expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ policyRevision: expected }));
});

test('real configuration mutation and restoration cannot revive a prior continuation', () => {
  const f = fixture(), issued = f.policy.capture();
  f.configuration.setRuntimeOverride('behavior.autoApprove', true);
  expect(f.policy.current()).not.toBe(issued);
  f.configuration.setRuntimeOverride('behavior.autoApprove', false);
  expect(f.configuration.get('behavior.autoApprove')).toBe(false);
  expect(f.policy.current()).not.toBe(issued);
  const successor = f.policy.capture(); expect(successor).not.toBe(issued); expect(f.policy.current()).toBe(successor);
  expect(createDaemonContinuationPolicy(f.restart(), f.owner).current()).not.toBe(issued);
});

test('workspace revision changes revoke saved bindings and a new issuance binds the changed scope', () => {
  const f = fixture(), issued = f.policy.capture();
  f.changeScope('next-workspace-policy', ['read:work-ledger']);
  expect(f.policy.current()).not.toBe(issued);
  expect(f.policy.scopes()).toEqual(['read:work-ledger']);
  const successor = f.policy.capture(); expect(successor).not.toBe(issued); expect(f.policy.current()).toBe(successor);
  expect(createDaemonContinuationPolicy(f.restart(), f.owner).current()).toBe(successor);
});

test('original live policy invalidation remains subscribed to the actual configuration owner', () => {
  const f = fixture(); f.policy.capture(); let invalidations = 0;
  const release = f.policy.onDidInvalidate(() => { invalidations++; });
  try { f.configuration.setRuntimeOverride('behavior.autoApprove', true); expect(invalidations).toBeGreaterThan(0); }
  finally { release(); }
});

test('replacing an original owner reader cannot retarget an issued policy check', () => {
  const f = fixture(); f.policy.capture();
  const original = f.owner.current;
  f.owner.current = () => ({ revision: 'replacement', scopes: ['*'] });
  expect(() => f.policy.current()).toThrow('owner changed');
  expect(() => f.policy.capture()).toThrow('owner changed');
  expect(() => f.policy.scopes()).toThrow('owner changed');
  f.owner.current = original;
  expect(() => f.policy.current()).toThrow('owner changed');
});
