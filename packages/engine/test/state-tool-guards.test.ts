/**
 * The state tool tells the model the truth: a refused batch writes nothing and
 * says so, failures are counted, listings only name keys that can be read back,
 * and hooks the model adds can be managed afterwards.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateTool, type HookChangeGate } from '../platform/src/platform/tools/state/index.ts';
import { createHookDispatcher } from '../platform/src/platform/hooks/index.ts';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { TelemetryDB } from '../platform/src/platform/state/telemetry.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(options: { gate?: HookChangeGate; swap?: boolean; telemetry?: TelemetryDB } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gv-state-guards-')); roots.push(root);
  const dispatcher = createHookDispatcher();
  const swaps: string[] = [];
  const tool = createStateTool(new KVState({ stateDir: join(root, 'state') }), new ProjectIndex(root), {
    hookDispatcher: dispatcher, ...(options.gate ? { hookGate: options.gate } : {}),
    ...(options.telemetry ? { telemetryDB: options.telemetry } : {}),
    ...(options.swap ? { swapManager: { async requestSwap(dir: string) { swaps.push(dir); return { ok: true }; } } } : {}),
  });
  return { tool, dispatcher, swaps };
}
const out = (result: { output?: string | undefined }) => JSON.parse(result.output ?? '{}') as Record<string, unknown>;

describe('mode=set with runtime.workingDir', () => {
  test('a batch that also carries other keys is refused whole: no swap, nothing written', async () => {
    const { tool, swaps } = setup({ swap: true });
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/p', plan: 'x' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('must be set on its own');
    expect(swaps).toEqual([]);
    expect(out(await tool.execute({ mode: 'get', keys: ['plan'] })).values).toEqual({});
  });

  test('alone it still swaps', async () => {
    const { tool, swaps } = setup({ swap: true });
    expect((await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/p' } })).success).toBe(true);
    expect(swaps).toEqual(['/p']);
  });
});

describe('mode=telemetry', () => {
  test('counts every failed or refused call, not only thrown ones', async () => {
    const { tool } = setup();
    expect((await tool.execute({ mode: 'get' })).success).toBe(false);
    expect((await tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'a.b' })).success).toBe(false);
    expect((await tool.execute({ mode: 'hooks', hookAction: 'add', hookDefinition: { eventPattern: 'Pre:tool:*', type: 'command', match: 'Pre:tool:*', command: 'x', name: 'n' } })).success).toBe(false);
    const telemetry = out(await tool.execute({ mode: 'telemetry' }));
    expect(telemetry.errors).toBe(3);
    expect(telemetry.tool_calls).toBe(4);
  });
});

describe('mode=list', () => {
  test('without a view returns the key inventory, not every stored value', async () => {
    const { tool } = setup();
    await tool.execute({ mode: 'set', values: { plan: { long: 'VALUE_BODY' } } });
    const summary = await tool.execute({ mode: 'list' });
    expect(summary.output).not.toContain('VALUE_BODY');
    expect(out(summary).entries as unknown[]).toContainEqual({ key: 'plan', type: 'object' });
    expect((await tool.execute({ mode: 'list', view: 'full' })).output).toContain('VALUE_BODY');
  });
});

describe('mode=analytics', () => {
  test('the model cannot record telemetry rows', async () => {
    const db = new TelemetryDB();
    const { tool } = setup({ telemetry: db });
    const result = await tool.execute({ mode: 'analytics', analyticsAction: 'record', analyticsTool: 'fetch' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('forged telemetry');
    expect(db.query({})).toEqual([]);
    const schema = tool.definition.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.analyticsAction!.enum).not.toContain('record');
  });
});

describe('mode=hooks add', () => {
  const approve: HookChangeGate = async () => ({ approved: true });
  const def = (extra: Record<string, unknown>) => ({ eventPattern: 'Pre:tool:exec', match: 'Pre:tool:exec', ...extra });

  test('a nameless hook is refused, because nothing could address it later', async () => {
    const { tool, dispatcher } = setup({ gate: approve });
    const result = await tool.execute({ mode: 'hooks', hookAction: 'add', hookDefinition: def({ type: 'command', command: 'echo' }) });
    expect(result.success).toBe(false);
    expect(result.error).toContain('name is required');
    expect(dispatcher.listHooks()).toEqual([]);
  });

  test('a second hook with a taken name is refused and the first stays addressable', async () => {
    const { tool, dispatcher } = setup({ gate: approve });
    const add = { mode: 'hooks', hookAction: 'add', hookDefinition: def({ type: 'command', command: 'echo', name: 'one' }) };
    const first = await tool.execute(add);
    expect(first.success).toBe(true);
    expect(out(first).persisted).toBe(false);
    const second = await tool.execute(add);
    expect(second.success).toBe(false);
    expect(second.error).toContain('already exists');
    expect(dispatcher.listHooks()).toHaveLength(1);
    expect((await tool.execute({ mode: 'hooks', hookAction: 'remove', hookName: 'one' })).success).toBe(true);
  });

  test('two parallel adds of one name register one hook, the second is refused', async () => {
    const release: Array<() => void> = [];
    const { tool, dispatcher } = setup({ gate: () => new Promise((resolve) => { release.push(() => resolve({ approved: true })); }) });
    const add = { mode: 'hooks', hookAction: 'add', hookDefinition: def({ type: 'command', command: 'echo', name: 'dup' }) };
    const first = tool.execute(add), second = tool.execute(add);
    await Promise.resolve(); await Promise.resolve();
    expect(release).toHaveLength(2);
    release.forEach((approveCall) => approveCall());
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toContain('Nothing was added');
    expect(dispatcher.listHooks()).toHaveLength(1);
  });

  test('the field a hook type runs is required before the owner is asked', async () => {
    let asked = 0;
    const { tool, dispatcher } = setup({ gate: async () => { asked++; return { approved: true }; } });
    for (const type of ['command', 'http', 'ts']) {
      const result = await tool.execute({ mode: 'hooks', hookAction: 'add', hookDefinition: def({ type, name: `h-${type}` }) });
      expect(result.success).toBe(false);
    }
    expect(asked).toBe(0);
    expect(dispatcher.listHooks()).toEqual([]);
  });
});
