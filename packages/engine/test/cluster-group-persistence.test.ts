/** A refused key save does not take a machine out of its group. */
import { expect, test } from 'bun:test';
import { createGroup } from '../platform/src/platform/cluster/group-operations.ts';
import { GroupKeyNotSavedError } from '../platform/src/platform/cluster/group-runtime.ts';
import { GROUP_MATERIAL_SECRET_KEY } from '../platform/src/platform/cluster/group-store.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, MemorySecretStore, stopGroupWorld } from './cluster-group-harness.ts';

/** The real in-memory secret store, with one refused write or one failed read on request: the store is outside the group runtime. */
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

test('a refused key save keeps this machine in its group on the key it holds, and the next attempt saves', async () => {
  const world = createGroupWorld(), secrets = new RefusingSecrets();
  try {
    const node = await addGroupNode(world, 'refused-save', { secrets });
    const created = await createGroup(node.context, {}); if (!created.ok) throw new Error(created.error);
    const held = node.runtime.keyring().currentGeneration;
    secrets.refuseNextSet = true;
    await expect(node.runtime.rotate('scheduled', 'fixture rotation')).rejects.toBeInstanceOf(GroupKeyNotSavedError);
    expect(node.runtime.membership).toBe('member');
    expect(node.runtime.keyring().groupId).toBe(created.data.groupId);
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
    await node.runtime.runHousekeeping();
    expect(node.runtime.membership).toBe('member');
    expect(node.runtime.keyring().groupId).toBe(created.data.groupId);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
