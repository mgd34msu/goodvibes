/**
 * The remote and task tools refuse changes that would silently do something else
 * than what the model asked: assigning to a pool nobody created, replacing a
 * registered runner contract from a file, a second open handoff for one task.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRunnerRegistry } from '../platform/src/platform/runtime/remote/runner-registry.ts';
import type { RemoteRunnerContract } from '../platform/src/platform/runtime/remote/types.ts';
import { createRemoteTool } from '../platform/src/platform/tools/remote-trigger/index.ts';
import { createTaskTool } from '../platform/src/platform/tools/task/index.ts';
import { CrossSessionTaskRegistry } from '../platform/src/platform/sessions/orchestration/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'gv-remote-task-')); roots.push(root); return root; };

function contract(runnerId: string, trustClass: RemoteRunnerContract['trustClass'] = 'local-daemon'): RemoteRunnerContract {
  return {
    id: `contract-${runnerId}`, runnerId, label: runnerId, sourceTransport: 'daemon', trustClass, template: 'general',
    capabilityCeiling: { allowedTools: ['read'], capabilityCeilingTools: ['read'], reviewMode: 'none', communicationLane: 'parent-only', orchestrationDepth: 0, successCriteria: [], requiredEvidence: [] },
    createdAt: 1, lastUpdatedAt: 1, transport: { state: 'connected', messageCount: 0, errorCount: 0 },
  } as unknown as RemoteRunnerContract;
}
function remote(options?: { importRoot?: string }) {
  const registry = new RemoteRunnerRegistry({ getStatus: () => undefined, list: () => [] } as never, undefined);
  return { registry, tool: createRemoteTool(registry, options) };
}

test('assigning to a pool that does not exist is refused and creates nothing', async () => {
  const { registry, tool } = remote();
  registry.registerContract(contract('runner-1'));
  const result = await tool.execute({ mode: 'assign', poolId: 'typo-pool', runnerId: 'runner-1' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Unknown pool');
  expect(registry.listPools()).toEqual([]);
});

test('assigning a runner that has no contract is refused', async () => {
  const { registry, tool } = remote();
  registry.createPool({ id: 'pool-1' });
  const result = await tool.execute({ mode: 'assign', poolId: 'pool-1', runnerId: 'ghost' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Unknown runner');
  expect(registry.getPool('pool-1')!.runnerIds).toEqual([]);
});

test('a full pool says it is full', async () => {
  const { registry, tool } = remote();
  registry.createPool({ id: 'pool-1', maxRunners: 1 });
  registry.registerContract(contract('runner-1')); registry.registerContract(contract('runner-2'));
  expect((await tool.execute({ mode: 'assign', poolId: 'pool-1', runnerId: 'runner-1' })).success).toBe(true);
  const result = await tool.execute({ mode: 'assign', poolId: 'pool-1', runnerId: 'runner-2' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('is full');
});

test('create-pool on an existing pool changes nothing and says so', async () => {
  const { registry, tool } = remote();
  registry.createPool({ id: 'pool-1', label: 'Original' });
  const result = await tool.execute({ mode: 'create-pool', poolId: 'pool-1', label: 'Renamed' });
  expect(result.success).toBe(false);
  expect(registry.getPool('pool-1')!.label).toBe('Original');
});

test('an artifact file cannot replace the contract of a registered runner', async () => {
  const { registry, tool } = remote();
  registry.registerContract(contract('runner-1', 'local-daemon'));
  const file = join(tempRoot(), 'forged.json');
  writeFileSync(file, JSON.stringify({ runnerContract: { ...contract('runner-1', 'self-hosted-acp') } }));
  const result = await tool.execute({ mode: 'import-artifact', path: file });
  expect(result.success).toBe(false);
  expect(result.error).toContain('already has a contract');
  expect(registry.listContracts().find((entry) => entry.runnerId === 'runner-1')!.trustClass).toBe('local-daemon');
});

test('an artifact file cannot change the workspace or pool of a registered runner even when trust and ceiling match', async () => {
  const { registry, tool } = remote();
  registry.registerContract(contract('runner-1', 'local-daemon'));
  const file = join(tempRoot(), 'forged.json');
  writeFileSync(file, JSON.stringify({ runnerContract: { ...contract('runner-1', 'local-daemon'), workspaceRoot: '/elsewhere', template: 'other' } }));
  const result = await tool.execute({ mode: 'import-artifact', path: file });
  expect(result.success).toBe(false);
  expect(result.error).toContain('already has a contract');
  expect(registry.listContracts().find((entry) => entry.runnerId === 'runner-1')!.template).toBe('general');
});

test('import-artifact reads only inside the project when the host names one, and a bad file is a failed result', async () => {
  const project = tempRoot(), elsewhere = tempRoot();
  const { tool } = remote({ importRoot: project });
  const outside = join(elsewhere, 'a.json');
  writeFileSync(outside, '{}');
  const refused = await tool.execute({ mode: 'import-artifact', path: outside });
  expect(refused.success).toBe(false);
  expect(refused.error).toContain('inside the project');
  const inside = join(project, 'a.json');
  writeFileSync(inside, 'not json');
  const failed = await tool.execute({ mode: 'import-artifact', path: inside });
  expect(failed.success).toBe(false);
});

test('a task with an open handoff cannot be handed off a second time', async () => {
  const registry = new CrossSessionTaskRegistry(join(tempRoot(), 'tasks.json'), { sweepIntervalMs: 0 });
  try {
    const tool = createTaskTool(registry, { resolveSessionId: () => 'session-a' });
    expect((await tool.execute({ mode: 'create', taskId: 't1', title: 'Task' })).success).toBe(true);
    const first = await tool.execute({ mode: 'handoff', taskId: 't1', toSessionId: 'session-b' });
    expect(first.success).toBe(true);
    const second = await tool.execute({ mode: 'handoff', taskId: 't1', toSessionId: 'session-c' });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already has an open handoff');
    expect(registry.getHandoffs()).toHaveLength(1);
  } finally { registry.dispose(); }
});
