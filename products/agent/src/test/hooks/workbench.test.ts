import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  getTestHookDispatcher,
  getTestHookWorkbench,
  resetTestRuntimeServices,
} from '../helpers/runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('HookWorkbench', () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-hook-workbench');
    resetTestRuntimeServices();
    (await getTestHookDispatcher()).clear();
  });

  afterEach(async () => {
    (await getTestHookDispatcher()).clear();
    resetTestRuntimeServices();
  });

  test('scaffolds managed hooks and chains, saves them, and simulates matches', async () => {
    const filePath = join(dir, 'hooks.json');
    const workbench = (await getTestHookWorkbench());
    workbench.loadManagedConfig(filePath);
    workbench.scaffoldHook('guard-edit', 'Pre:tool:*', 'command');
    workbench.scaffoldChain('edit-review-loop', ['Post:tool:edit', 'Fail:tool:edit']);
    await workbench.saveManagedConfig(filePath);
    await workbench.loadAndApplyManagedHooks(filePath);

    expect((await getTestHookDispatcher()).listHooks().length).toBe(1);
    expect((await getTestHookDispatcher()).getChains().length).toBe(1);

    const simulation = workbench.simulate('Pre:tool:edit');
    expect(simulation.matchedHooks.length).toBe(1);
    expect(simulation.matchedHooks[0]?.name).toBe('guard-edit');
    expect(workbench.listRecentActions(2)[0]?.kind).toBe('simulate');
  });
});
