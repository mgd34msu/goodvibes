import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
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

test('current live checks preserve the existing saved native CI policy representation', () => {
  const f = fixture(), binding = f.policy.capture();
  const expected = createHash('sha256').update(JSON.stringify([f.configuration.getDurableConfigurationIncarnation(), f.owner.current().revision])).digest('hex');
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
