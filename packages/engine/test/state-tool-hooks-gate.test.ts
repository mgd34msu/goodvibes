import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateTool, type HookChangeGate, type HookChangeRequest } from '../platform/src/platform/tools/state/index.ts';
import { createHookDispatcher } from '../platform/src/platform/hooks/index.ts';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';

function setup(gate?: HookChangeGate) {
  const root = mkdtempSync(join(tmpdir(), 'gv-state-hooks-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  const dispatcher = createHookDispatcher();
  const tool = createStateTool(new KVState({ stateDir: join(root, 'state') }), new ProjectIndex(root), {
    hookDispatcher: dispatcher, ...(gate ? { hookGate: gate } : {}),
  });
  return { tool, dispatcher };
}
const add = { mode: 'hooks', hookAction: 'add', hookDefinition: { eventPattern: 'Pre:tool:exec', type: 'command', match: 'Pre:tool:exec', command: 'echo hi', name: 'greeter' } };

describe('state mode=hooks behind an approval gate', () => {
  test('the mode is advertised, and with no gate hooks can be listed but not changed', async () => {
    const { tool, dispatcher } = setup();
    expect((tool.definition.parameters as { properties: { mode: { enum: string[] } } }).properties.mode.enum).toContain('hooks');
    expect(JSON.parse((await tool.execute({ mode: 'hooks', hookAction: 'list' })).output!).count).toBe(0);
    const refused = await tool.execute(add);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('Nothing was changed');
    expect(dispatcher.listHooks()).toEqual([]);
  });

  test('an approved add registers the hook; the gate saw the command that would run', async () => {
    const seen: HookChangeRequest[] = [];
    const { tool, dispatcher } = setup(async request => { seen.push(request); return { approved: true }; });
    expect((await tool.execute(add)).success).toBe(true);
    expect(dispatcher.listHooks().map(entry => entry.hook.name)).toEqual(['greeter']);
    expect(seen).toMatchObject([{ action: 'add', eventPattern: 'Pre:tool:exec', hook: { type: 'command', command: 'echo hi' } }]);
  });

  test('a refused add registers nothing and says why; enable, disable and remove are gated the same way', async () => {
    let approve = true;
    const actions: string[] = [];
    const { tool, dispatcher } = setup(async request => { actions.push(request.action); return approve ? { approved: true } : { approved: false, reason: 'the user declined' }; });
    await tool.execute(add);
    approve = false;
    for (const hookAction of ['disable', 'enable', 'remove']) {
      const result = await tool.execute({ mode: 'hooks', hookAction, hookName: 'greeter' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('the user declined');
    }
    expect(dispatcher.listHooks().map(entry => [entry.hook.name, entry.hook.enabled])).toEqual([['greeter', undefined]]);
    expect(actions).toEqual(['add', 'disable', 'enable', 'remove']);
    const second = await tool.execute({ ...add, hookDefinition: { ...add.hookDefinition, name: 'second' } });
    expect(second.error).toContain('refused');
    expect(dispatcher.listHooks()).toHaveLength(1);
  });
});
