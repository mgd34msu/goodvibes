/** A refused key save does not take a machine out of its group. */
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
