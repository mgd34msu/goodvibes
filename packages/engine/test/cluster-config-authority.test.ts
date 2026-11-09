/** UNRUN: real authenticated group traffic and controlled storage awaits. */
import { expect, test } from 'bun:test';
import { createGroup, joinGroup } from '../platform/src/platform/cluster/group-operations.js';
import { CONFIG_MESSAGE_TYPES } from '../platform/src/platform/cluster/config-replication.js';
import { encodeEnvelope } from '../platform/src/platform/cluster/protocol-envelope.js';
import { findReplicaEntry } from '../platform/src/platform/cluster/config-replica.js';
import { listReplicatedConfigPaths, replicatedSecretKeyFor } from '../platform/src/platform/cluster/config-replication-policy.js';
import { admitMember, removeMember, touchMember } from '../platform/src/platform/cluster/group-state.js';
import { addGroupNode, createGroupWorld, destroyGroupWorld, MemorySecretStore, settle, stopGroupWorld } from './cluster-group-harness.js';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class PausedSecrets extends MemorySecretStore {
  readWait: ((key: string) => Promise<void>) | undefined;
  writeWait: ((key: string) => Promise<void>) | undefined;
  deleteWait: ((key: string) => Promise<void>) | undefined;
  readonly deleted: string[] = [];
  override async get(key: string) { const value = await super.get(key); await this.readWait?.(key); return value; }
  override async set(key: string, value: string) { await super.set(key, value); await this.writeWait?.(key); }
  override async delete(key: string) { this.deleted.push(key); await super.delete(key); await this.deleteWait?.(key); }
}
const paths = listReplicatedConfigPaths().filter(path => path.startsWith('surfaces.')).sort((a, b) => a.localeCompare(b));
function secretPath(index = 0): string {
  const path = paths[index]; if (!path) throw new Error('Fixture requires actual replicated surface credential paths'); return path;
}
function sealedMessages(wire: readonly { from: string; raw: string }[], sender: string) {
  return wire.filter(row => row.from === sender).map(row => JSON.parse(row.raw) as { type: string; body?: { sealed?: unknown } })
    .filter(message => message.type === CONFIG_MESSAGE_TYPES.delta && message.body?.sealed !== undefined);
}

for (const change of ['remove', 'readmit', 'rotate', 'heartbeat'] as const) {
  test(`a delayed snapshot secret read stays bound to its original requester across ${change}`, async () => {
    const world = createGroupWorld(), secrets = new PausedSecrets(), entered = barrier(), release = barrier();
    try {
      const master = await addGroupNode(world, 'authority-master', { secrets, isMaster: true });
      const created = await createGroup(master.context, {}); if (!created.ok) throw new Error(created.error);
      const peer = await addGroupNode(world, 'authority-peer');
      const joined = await joinGroup(peer.context, { groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw new Error(joined.error);
      await settle();
      const path = secretPath(), key = replicatedSecretKeyFor(path);
      await secrets.set(key, 'synthetic-replicated-secret'); await master.runtime.announceSecretChange(path); await settle();
      const start = world.wire.length;
      secrets.readWait = async requested => { if (requested === key) { entered.resolve(); await release.promise; } };
      const request = peer.runtime.requestConfigSnapshot(); await entered.promise;
      const state = master.runtime.groupState!;
      const member = state.members.find(item => item.nodeId === peer.id)!;
      if (change === 'remove') await master.runtime.commitState(removeMember(state, peer.id, 'fixture revoked', world.clock.now()), false);
      else if (change === 'readmit') {
        const removed = removeMember(state, peer.id, 'fixture revoked', world.clock.now());
        const readded = admitMember(removed, { nodeId: peer.id, displayName: member.displayName,
          identityKey: member.identityKey, agreementKey: member.agreementKey, now: world.clock.now() + 1 });
        await master.runtime.commitState(readded.state, false);
      } else if (change === 'rotate') await master.runtime.rotate('revocation', 'fixture immediate key retirement');
      else await master.runtime.commitState(touchMember(state, peer.id, world.clock.now() + 1), false);
      release.resolve(); await request; await settle();
      const sent = sealedMessages(world.wire.slice(start), master.id);
      expect(sent.length).toBe(change === 'heartbeat' ? 1 : 0);
    } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
  });
}

test('revoking a proposal sender during an entered secret set prevents later publication without undoing the entered write', async () => {
  const world = createGroupWorld(), secrets = new PausedSecrets(), entered = barrier(), release = barrier();
  try {
    const master = await addGroupNode(world, 'proposal-master', { secrets, isMaster: true });
    const created = await createGroup(master.context, {}); if (!created.ok) throw new Error(created.error);
    const peer = await addGroupNode(world, 'proposal-peer');
    const joined = await joinGroup(peer.context, { groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw new Error(joined.error);
    await settle();
    const path = secretPath(), key = replicatedSecretKeyFor(path);
    await peer.secrets.set(key, 'synthetic-proposed-secret');
    secrets.writeWait = async written => { if (written === key) { entered.resolve(); await release.promise; } };
    const start = world.wire.length, announced = peer.runtime.announceSecretChange(path); await entered.promise;
    await master.runtime.commitState(removeMember(master.runtime.groupState!, peer.id, 'fixture revoked', world.clock.now()), false);
    release.resolve(); await announced; await settle();
    expect(await secrets.get(key)).toBe('synthetic-proposed-secret');
    expect(findReplicaEntry(master.runtime.replicaDocument()!, path)).toBeNull();
    expect(sealedMessages(world.wire.slice(start), master.id)).toHaveLength(0);
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('a revoked document sender cannot start a second secret deletion after the first storage await', async () => {
  const world = createGroupWorld(), secrets = new PausedSecrets(), entered = barrier(), release = barrier();
  try {
    const master = await addGroupNode(world, 'deletion-master', { isMaster: true });
    const created = await createGroup(master.context, {}); if (!created.ok) throw new Error(created.error);
    const peer = await addGroupNode(world, 'deletion-peer', { secrets });
    const joined = await joinGroup(peer.context, { groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw new Error(joined.error);
    await settle();
    const first = secretPath(), second = secretPath(1), firstKey = replicatedSecretKeyFor(first), secondKey = replicatedSecretKeyFor(second);
    await secrets.set(firstKey, 'synthetic-first-secret'); await secrets.set(secondKey, 'synthetic-second-secret');
    secrets.deleteWait = async key => { if (key === firstKey) { entered.resolve(); await release.promise; } };
    const sent = master.transport.send(encodeEnvelope({ type: CONFIG_MESSAGE_TYPES.delta, nodeId: master.id,
      nodeVersion: '1.0.0', seq: 100_000, ts: world.clock.now(), body: { deletes: [
      { path: first, revision: 1, origin: master.id, at: world.clock.now(), secret: true },
      { path: second, revision: 2, origin: master.id, at: world.clock.now(), secret: true },
    ] } }, master.runtime.keyring()));
    await entered.promise;
    await peer.runtime.commitState(removeMember(peer.runtime.groupState!, master.id, 'fixture revoked', world.clock.now()), false);
    release.resolve(); await sent; await settle();
    expect(secrets.deleted).toEqual([firstKey]);
    expect(await secrets.get(firstKey)).toBeNull(); expect(await secrets.get(secondKey)).toBe('synthetic-second-secret');
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});
