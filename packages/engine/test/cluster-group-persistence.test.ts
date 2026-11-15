/** The roster file is written on real change only, and a refused key save does not take a machine out of its group. */
import { expect, spyOn, test } from 'bun:test';
import { createGroup, groupNodes, joinGroup } from '../platform/src/platform/cluster/group-operations.ts';
import { GroupKeyNotSavedError } from '../platform/src/platform/cluster/group-runtime.ts';
import { GroupStateOwner } from '../platform/src/platform/cluster/group-state-owner.ts';
import { GROUP_MATERIAL_SECRET_KEY, GROUP_STATE_FILENAME } from '../platform/src/platform/cluster/group-store.ts';
import { addGroupNode, advance, createGroupWorld, destroyGroupWorld, MemorySecretStore, settle, stopGroupWorld } from './cluster-group-harness.ts';

class RefusingSecrets extends MemorySecretStore {
  refuseNextSet = false;
  failNextGet = false;
  override async set(key: string, value: string): Promise<void> {
    if (key === GROUP_MATERIAL_SECRET_KEY && this.refuseNextSet) { this.refuseNextSet = false; throw new Error('fixture store busy'); }
    await super.set(key, value);
  }
  override async get(key: string): Promise<string | null> {
    if (key === GROUP_MATERIAL_SECRET_KEY && this.failNextGet) { this.failNextGet = false; throw new Error('fixture store unavailable'); }
    return super.get(key);
  }
}

test('beacons and repeated roster gossip write the roster file zero times, and cluster nodes still shows who was heard', async () => {
  const world = createGroupWorld();
  try {
    const first = await addGroupNode(world, 'roster-a');
    const created = await createGroup(first.context, {}); if (!created.ok) throw new Error(created.error);
    const second = await addGroupNode(world, 'roster-b');
    const joined = await joinGroup(second.context, { groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw new Error(joined.error);
    await settle();
    const writes = spyOn(GroupStateOwner.prototype, 'write');
    try {
      for (let step = 0; step < 12; step += 1) await advance(world, 5_000);
      expect(writes.mock.calls.filter(([name]) => name === GROUP_STATE_FILENAME).length).toBe(0);
    } finally { writes.mockRestore(); }
    const nodes = groupNodes(first.context);
    if (!nodes.ok) throw new Error(nodes.error);
    expect(nodes.data.members.find(member => member.nodeId === second.id)).toMatchObject({ heardSinceStart: true });
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('a refused key save keeps this machine in its group on the key it holds, and the next attempt saves', async () => {
  const world = createGroupWorld(), secrets = new RefusingSecrets();
  try {
    const node = await addGroupNode(world, 'refused-save', { secrets });
    const created = await createGroup(node.context, {}); if (!created.ok) throw new Error(created.error);
    const held = node.runtime.keyring().currentGeneration;
    secrets.refuseNextSet = true;
    await expect(node.runtime.rotate('scheduled', 'fixture rotation')).rejects.toBeInstanceOf(GroupKeyNotSavedError);
    expect(node.runtime.membership).toBe('member');
    expect(node.runtime.keyring().currentGeneration).toBe(held);
    await node.runtime.rotate('scheduled', 'fixture rotation');
    expect(node.runtime.keyring().currentGeneration).toBe(held + 1);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('a refused key save whose store cannot be read back is recovered by the next housekeeping pass', async () => {
  const world = createGroupWorld(), secrets = new RefusingSecrets();
  try {
    const node = await addGroupNode(world, 'unknown-save', { secrets });
    const created = await createGroup(node.context, {}); if (!created.ok) throw new Error(created.error);
    secrets.refuseNextSet = true; secrets.failNextGet = true;
    await expect(node.runtime.rotate('scheduled', 'fixture rotation')).rejects.toThrow();
    expect(node.runtime.membership).toBe('unreadable-key-material');
    expect(node.runtime.keyring().groupId).toBe('');
    await node.runtime.runHousekeeping();
    expect(node.runtime.membership).toBe('member');
    expect(node.runtime.keyring().groupId).toBe(created.data.groupId);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
