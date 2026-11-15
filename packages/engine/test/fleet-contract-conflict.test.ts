/**
 * A contract unit whose work item failed to merge shows as needing the owner:
 * the conflict reason with the first conflicting file, until the item merges.
 */
import { describe, expect, test } from 'bun:test';
import { createProcessRegistry } from '../platform/src/platform/runtime/fleet/index.ts';
import type { ProcessRegistryDeps } from '../platform/src/platform/runtime/fleet/registry.ts';
import type { Contract, ContractView } from '../platform/src/platform/contract/types.ts';
import type { ContractConflictItem } from '../platform/src/platform/contract/fleet-controls.ts';
import { makeContract, makeUnit } from './contract/fixtures.ts';

const T0 = 1_750_000_000_000;

function registryOver(contract: Contract, items: () => readonly ContractConflictItem[]) {
  const deps: ProcessRegistryDeps = {
    agentManager: { list: () => [], cancel: () => false },
    contractRunner: {
      list: () => [contract] as ContractView[],
      cancel: () => false,
      fleetControls: () => ({ listWorkstreams: () => [{ id: `${contract.id}:w1`, items: items() }] }) as never,
    },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    now: () => T0,
  };
  return createProcessRegistry(deps);
}

describe('contract unit merge conflict', () => {
  const contract = makeContract({ id: 'c1', createdAt: T0, units: [makeUnit({ id: 'u1' }), makeUnit({ id: 'u2' })] });

  test('a unit whose item conflicted needs attention with its first conflicting file; others do not', () => {
    const registry = registryOver(contract, () => [
      { id: 'c1:u1', title: 'Unit one', mergeState: 'conflict', conflictFiles: ['src/a.ts', 'src/b.ts'] },
      { id: 'c1:u2', title: 'Unit two', mergeState: 'merged' },
    ]);
    try {
      expect(registry.getNode('unit:c1:u1')?.needsAttention).toEqual({ reason: 'conflict', detail: 'src/a.ts' });
      expect(registry.getNode('unit:c1:u2')?.needsAttention).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  test('the title stands in when no file was recorded, and the flag clears once the item merges', () => {
    let state: ContractConflictItem = { id: 'c1:u1', title: 'Unit one', mergeState: 'conflict' };
    const registry = registryOver(contract, () => [state]);
    try {
      expect(registry.getNode('unit:c1:u1')?.needsAttention).toEqual({ reason: 'conflict', detail: 'Unit one' });
      state = { ...state, mergeState: 'merged' };
      expect(registry.getNode('unit:c1:u1')?.needsAttention).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });
});
