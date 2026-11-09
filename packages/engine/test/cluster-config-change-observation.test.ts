/** UNRUN: exact operation origin and original queue ownership. */
import { expect, test } from 'bun:test';
import { GroupConfigChanges } from '../platform/src/platform/cluster/group-config-changes.ts';
import { listReplicatedConfigPaths, replicatedSecretKeyFor } from '../platform/src/platform/cluster/config-replication-policy.ts';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function pathAt(index: number) { const value = listReplicatedConfigPaths()[index]; if (!value) throw Error('Missing actual policy fixture'); return value; }
async function turns() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
test('remote async suppression belongs only to its exact entered kind/key; unrelated local notifications still replicate', async () => {
  const first = pathAt(0), second = pathAt(1), key = replicatedSecretKeyFor(first), gate = Promise.withResolvers<void>();
  const listeners = new Set<(key: string) => void>(), applied: string[] = [];
  const changes = new GroupConfigChanges({ logger, config: undefined, owner: () => ({ revision: 1, generation: 1, master: false }), capture: () => () => {},
    secrets: { async get() { return null; }, async set(changed) { await gate.promise; for (const listener of listeners) listener(changed); }, async delete() {}, onDidChange(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async apply(change) { change.assertCurrent(); applied.push(change.path); } });
  changes.start(); const remote = changes.secretStore().set(key, 'synthetic-not-cached');
  for (const listener of listeners) listener(replicatedSecretKeyFor(second)); await turns(); expect(applied).toEqual([second]);
  gate.resolve(); await remote; await changes.join(); expect(applied).toEqual([second]); changes.stop(); expect(listeners.size).toBe(0);
});
test('a callback inheriting an already settled remote async context cannot suppress a later genuine notification', async () => {
  const path = pathAt(0), key = replicatedSecretKeyFor(path), later = Promise.withResolvers<void>(), applied: string[] = [], listeners = new Set<(key: string) => void>();
  const changes = new GroupConfigChanges({ logger, config: undefined, owner: () => ({ revision: 1, generation: 1, master: false }), capture: () => () => {},
    secrets: { async get() { return null; }, async set(changed) { for (const listener of listeners) listener(changed); void later.promise.then(() => { for (const listener of listeners) listener(changed); }); }, async delete() {}, onDidChange(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async apply(change) { change.assertCurrent(); applied.push(change.path); } });
  changes.start(); await changes.secretStore().set(key, 'synthetic-not-cached'); expect(applied).toEqual([]);
  later.resolve(); await turns(); await changes.join(); expect(applied).toEqual([path]); changes.stop();
});
test('queued metadata is bounded per policy path and cannot acquire a different membership after awaiting', async () => {
  const path = pathAt(0), key = replicatedSecretKeyFor(path), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let revision = 1, completed = 0; const listeners = new Set<(key: string) => void>();
  const changes = new GroupConfigChanges({ logger, config: undefined, owner: () => ({ revision, generation: 1, master: false }), capture() { const selected = revision; return () => { if (revision !== selected) throw Error('Original membership retired'); }; },
    secrets: { async get() { return null; }, async set() {}, async delete() {}, onDidChange(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async apply(change) { entered.resolve(); await release.promise; change.assertCurrent(); completed++; } });
  changes.start(); for (let i = 0; i < 1000; i++) for (const listener of listeners) listener(key);
  await entered.promise; revision++; release.resolve(); await changes.join(); expect(completed).toBe(0); changes.stop();
});

test('observed wrappers refuse a replacement constructor dependency instead of asserting new authority over an old receiver', () => {
  const original = { async get() { return null; }, async set() {}, async delete() {} }, replacement = { ...original };
  const changes = new GroupConfigChanges({ logger, config: undefined, secrets: original, owner: () => null, capture: () => () => {}, async apply() {} });
  expect(() => changes.assertStoresCurrent(undefined, original)).not.toThrow();
  expect(() => changes.assertStoresCurrent(undefined, replacement)).toThrow('Original local replicated change retired');
  expect(() => changes.assertStoresCurrent({ get() { return null; }, set() {} }, original)).toThrow();
});
