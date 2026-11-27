// Proves: A machine drops out of its group, losing the group key it held, because a key save was refused.
// Red when: A failed save during rotation discards the key in hand or the membership.
// Proves: A machine cannot start, join or change its group, and sends none of the owner's shared settings, once another store makes a folder above the group's state private.
// Red when: The group's state custody refuses a folder above it that only lost group and other access.

/** A refused key save does not take a machine out of its group. */
import { chmodSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { createGroup } from '../platform/src/platform/cluster/group-operations.ts';
import { GroupKeyNotSavedError } from '../platform/src/platform/cluster/group-runtime.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, stopGroupWorld, type GroupTestNode } from './cluster-group-harness.ts';

/** The daemon secret store refuses every write; what it already holds still reads. */
function refuseWrites(node: GroupTestNode): () => void {
  const store = node.context.secrets;
  const save = store.set;
  store.set = async () => { throw new Error('the secret store refused the write'); };
  return () => { store.set = save; };
}

test('a refused key save keeps this machine in its group on the key it holds, and the next attempt saves', async () => {
  const world = createGroupWorld();
  try {
    const node = await addGroupNode(world, 'refused-save');
    const created = await createGroup(node.context, {}); if (!created.ok) throw new Error(created.error);
    const held = node.runtime.keyring().currentGeneration;
    const restore = refuseWrites(node);
    await expect(node.runtime.rotate('scheduled', 'fixture rotation')).rejects.toBeInstanceOf(GroupKeyNotSavedError);
    restore();
    expect(node.runtime.membership).toBe('member');
    expect(node.runtime.keyring().groupId).toBe(created.data.groupId);
    expect(node.runtime.keyring().currentGeneration).toBe(held);
    await node.runtime.rotate('scheduled', 'fixture rotation');
    expect(node.runtime.keyring().currentGeneration).toBe(held + 1);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('a folder above the group state made private after the daemon started leaves the group working', async () => {
  const world = createGroupWorld();
  try {
    // As on a fresh home: the folder is 0755 when the daemon starts, and the secret store makes it 0700 when it writes
    // its first key (config/secrets-keyfile.ts).
    chmodSync(world.tempRoot, 0o755);
    const node = await addGroupNode(world, 'tightened-home');
    chmodSync(world.tempRoot, 0o700);
    const created = await createGroup(node.context, {});
    expect(created.ok ? created.data.groupId : created.error).toBe(node.runtime.keyring().groupId);
    expect(node.runtime.membership).toBe('member');
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
