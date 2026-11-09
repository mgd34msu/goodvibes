/** UNRUN: real signed frames, sealed recipients and persisted metadata ordering. */
import { expect, spyOn, test } from 'bun:test';
import { createGroup, joinGroup } from '../sdk/src/platform/cluster/group-operations.ts';
import { CONFIG_MESSAGE_TYPES } from '../sdk/src/platform/cluster/config-replication.ts';
import { sealForMember } from '../sdk/src/platform/cluster/group-crypto.ts';
import { encodeEnvelope } from '../sdk/src/platform/cluster/protocol-envelope.ts';
import { replicatedSecretKeyFor } from '../sdk/src/platform/cluster/config-replication-policy.ts';
import { findReplicaEntry } from '../sdk/src/platform/cluster/config-replica.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, settle, stopGroupWorld, MemorySecretStore } from './cluster-group-harness.ts';
const path = 'surfaces.telegram.botToken', key = replicatedSecretKeyFor(path), context = 'goodvibes-cluster-config-secret-v1';
async function paired(secrets?: MemorySecretStore) {
  const world = createGroupWorld(); const master = await addGroupNode(world, 'revision-master', { isMaster: true });
  const created = await createGroup(master.context, {}); if (!created.ok) throw Error(created.error);
  const peer = await addGroupNode(world, 'revision-peer', secrets ? { secrets } : {}); const joined = await joinGroup(peer.context, { groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw Error(joined.error);
  await settle(); let sequence = 100000;
  return { world, master, peer, async send(body: Record<string, unknown>) { await master.transport.send(encodeEnvelope({ type: CONFIG_MESSAGE_TYPES.delta, nodeId: master.id, nodeVersion: '1.0.0', seq: sequence++, ts: world.clock.now(), body }, master.runtime.keyring())); await settle(); } };
}
test('a newer tombstone blocks delayed old signed secret material before any store effect', async () => {
  const f = await paired();
  try {
    const member = f.master.runtime.groupState!.members.find(entry => entry.nodeId === f.peer.id)!;
    await f.peer.secrets.set(key, 'synthetic-previous');
    await f.send({ deletes: [{ path, revision: 20, origin: f.master.id, at: f.world.clock.now(), secret: true }] }); expect(await f.peer.secrets.get(key)).toBeNull();
    const write = spyOn(f.peer.secrets, 'set');
    try {
      await f.send({ secretPath: path, revision: 19, origin: f.master.id, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-delayed-old', context) } });
      expect(write).not.toHaveBeenCalled(); expect(await f.peer.secrets.get(key)).toBeNull(); expect(f.peer.runtime.replicaDocument()?.tombstones.find(entry => entry.path === path)?.revision).toBe(20);
    } finally { write.mockRestore(); }
  } finally { await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});
test('metadata-first equal-revision delivery preserves incoming revision and rejects lower, malformed or wrong-recipient frames', async () => {
  const f = await paired();
  try {
    const member = f.master.runtime.groupState!.members.find(entry => entry.nodeId === f.peer.id)!;
    await f.send({ entries: [{ path, revision: 30, origin: f.master.id, at: f.world.clock.now(), secret: true, value: { secretRevision: 30 } }] });
    await f.send({ secretPath: path, revision: 30, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-current', context) } });
    expect(await f.peer.secrets.get(key)).toBe('synthetic-current'); expect(findReplicaEntry(f.peer.runtime.replicaDocument()!, path)?.revision).toBe(30);
    const write = spyOn(f.peer.secrets, 'set');
    try {
      await f.send({ secretPath: path, revision: 29, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-older', context) } });
      await f.send({ secretPath: path, revision: 31.5, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-invalid', context) } });
      await f.send({ secretPath: path, revision: 31, sealed: { 'another-recipient': sealForMember(member.agreementKey, 'synthetic-wrong-recipient', context) } });
      expect(write).not.toHaveBeenCalled(); expect(await f.peer.secrets.get(key)).toBe('synthetic-current'); expect(findReplicaEntry(f.peer.runtime.replicaDocument()!, path)?.revision).toBe(30);
    } finally { write.mockRestore(); }
  } finally { await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});

test('a later accepted deletion drains an already-entered older set before leaving the credential absent', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  class PausedSecrets extends MemorySecretStore {
    override async set(selected: string, value: string) { await super.set(selected, value); if (selected === key) { entered.resolve(); await release.promise; } }
  }
  const secrets = new PausedSecrets(), f = await paired(secrets);
  try {
    const member = f.master.runtime.groupState!.members.find(entry => entry.nodeId === f.peer.id)!;
    const sending = f.send({ secretPath: path, revision: 40, origin: f.master.id, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-entered-old', context) } });
    await entered.promise;
    await f.send({ deletes: [{ path, revision: 41, origin: f.master.id, at: f.world.clock.now(), secret: true }] });
    release.resolve(); await sending; await settle();
    expect(await secrets.get(key)).toBeNull(); expect(findReplicaEntry(f.peer.runtime.replicaDocument()!, path)).toBeNull();
    expect(f.peer.runtime.replicaDocument()?.tombstones.find(entry => entry.path === path)?.revision).toBe(41);
  } finally { release.resolve(); await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});
test('public literal credentials and forged raw secret markers from an older peer are refused before local persistence/application', async () => {
  const f = await paired(), raw = 'synthetic-older-peer-literal-never-persist';
  try {
    const before = f.peer.config.get(path), write = spyOn(f.peer.config, 'set');
    try {
      await f.send({ entries: [{ path, revision: 50, origin: f.master.id, at: f.world.clock.now(), secret: false, value: raw }] });
      await f.send({ entries: [{ path, revision: 51, origin: f.master.id, at: f.world.clock.now(), secret: true, value: raw }] });
      expect(write).not.toHaveBeenCalled(); expect(f.peer.config.get(path)).toBe(before); expect(await f.peer.secrets.get(key)).toBeNull();
      expect(JSON.stringify(f.peer.runtime.replicaDocument())).not.toContain(raw);
    } finally { write.mockRestore(); }
  } finally { await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});
test('a queued deletion rechecks the original selected tombstone before it can erase newer secret material', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  class PausedSecrets extends MemorySecretStore {
    readonly deleted: string[] = [];
    override async set(selected: string, value: string) { await super.set(selected, value); if (selected === key && value === 'synthetic-entered-old') { entered.resolve(); await release.promise; } }
    override async delete(selected: string) { this.deleted.push(selected); await super.delete(selected); }
  }
  const secrets = new PausedSecrets(), f = await paired(secrets);
  try {
    const member = f.master.runtime.groupState!.members.find(entry => entry.nodeId === f.peer.id)!;
    const sending = f.send({ secretPath: path, revision: 60, origin: f.master.id, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-entered-old', context) } }); await entered.promise;
    await f.send({ deletes: [{ path, revision: 61, origin: f.master.id, at: f.world.clock.now(), secret: true }] });
    await f.send({ entries: [{ path, revision: 62, origin: f.master.id, at: f.world.clock.now(), secret: true, value: { secretRevision: 62 } }] });
    await f.send({ secretPath: path, revision: 62, origin: f.master.id, sealed: { [f.peer.id]: sealForMember(member.agreementKey, 'synthetic-new-current', context) } });
    release.resolve(); await sending; await settle(); expect(secrets.deleted).toEqual([]); expect(await secrets.get(key)).toBe('synthetic-new-current');
  } finally { release.resolve(); await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});
test('a failed entered deletion remains pending under its original authority and succeeds on owned housekeeping retry', async () => {
  class RetrySecrets extends MemorySecretStore {
    fail = true; calls = 0;
    override async delete(selected: string) { if (selected === key) { this.calls++; if (this.fail) throw Error('synthetic native store unavailable'); } await super.delete(selected); }
  }
  const secrets = new RetrySecrets(), f = await paired(secrets);
  try {
    await secrets.set(key, 'synthetic-before-delete');
    await f.send({ deletes: [{ path, revision: 70, origin: f.master.id, at: f.world.clock.now(), secret: true }] });
    expect(await secrets.get(key)).toBe('synthetic-before-delete'); expect(secrets.calls).toBe(1); secrets.fail = false;
    await f.peer.runtime.runHousekeeping(); await settle(); expect(await secrets.get(key)).toBeNull(); expect(secrets.calls).toBe(2);
  } finally { await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});

test('an accepted secret tombstone clears both the supported local literal config source and encrypted key', async () => {
  const f = await paired();
  try {
    f.peer.config.set(path, 'synthetic-local-literal'); await f.peer.secrets.set(key, 'synthetic-encrypted-copy');
    await f.send({ deletes: [{ path, revision: 80, origin: f.master.id, at: f.world.clock.now(), secret: true }] });
    expect(f.peer.config.get(path)).toBeUndefined(); expect(await f.peer.secrets.get(key)).toBeNull();
    expect(f.peer.runtime.replicaDocument()?.tombstones.find(entry => entry.path === path)?.revision).toBe(80);
  } finally { await stopGroupWorld(f.world); destroyGroupWorld(f.world); }
});
