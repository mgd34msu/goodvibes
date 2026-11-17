/** A refused key save does not take a machine out of its group. */
import { expect, test } from 'bun:test';
import { chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGroup } from '../platform/src/platform/cluster/group-operations.ts';
import { GroupKeyNotSavedError } from '../platform/src/platform/cluster/group-runtime.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, stopGroupWorld, type GroupTestNode } from './cluster-group-harness.ts';

/** The daemon secret store's directory refuses new files: a save fails, the saved key still reads. */
function refuseWrites(node: GroupTestNode): () => void {
  chmodSync(node.daemonSecretsDirectory, 0o500);
  return () => chmodSync(node.daemonSecretsDirectory, 0o700);
}

/** The daemon secret store can neither be written nor read. */
function refuseWritesAndReads(node: GroupTestNode): () => void {
  const files = readdirSync(node.daemonSecretsDirectory).map(name => join(node.daemonSecretsDirectory, name));
  for (const file of files) chmodSync(file, 0o000);
  const allowWrites = refuseWrites(node);
  return () => { allowWrites(); for (const file of files) chmodSync(file, 0o600); };
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

test('a refused key save whose store cannot be read stays unconfirmed, not groupless, until the store reads again', async () => {
  const world = createGroupWorld();
  try {
    const node = await addGroupNode(world, 'unknown-save');
    const created = await createGroup(node.context, {}); if (!created.ok) throw new Error(created.error);
    const restore = refuseWritesAndReads(node);
    try {
      await expect(node.runtime.rotate('scheduled', 'fixture rotation')).rejects.toThrow();
      expect(node.runtime.membership).toBe('unreadable-key-material');
      // A pass while the store still cannot be read must not take "unreadable" for "never joined".
      await node.runtime.runHousekeeping();
      expect(node.runtime.membership).toBe('unreadable-key-material');
    } finally { restore(); }
    await node.runtime.runHousekeeping();
    expect(node.runtime.membership).toBe('member');
    expect(node.runtime.keyring().groupId).toBe(created.data.groupId);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
