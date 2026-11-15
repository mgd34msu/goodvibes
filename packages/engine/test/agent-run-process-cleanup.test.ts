/** A finishing agent stops the background processes its own tool calls started, and no one else's. */
import { expect, test } from 'bun:test';
import { claimStartedProcesses, cleanupLeakedProcesses } from '../platform/src/platform/agents/orchestrator-runner-finish.js';
import type { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';

function fakeManager() {
  const running = new Map<string, string | undefined>();
  const stopped: string[] = [];
  const manager = {
    list: () => [...running].map(([id, startedBy]) => ({ id, pid: 1, cmd: id, status: 'running', done: false, startedBy })),
    hasBoundaryOwner: () => false,
    stop: (id: string) => { running.delete(id); stopped.push(id); return true; },
  } as unknown as ProcessManager;
  return { manager, start: (id: string, startedBy?: string) => { running.set(id, startedBy); }, running, stopped };
}

test('a process another run or the operator started during a run is left running when that run finishes', () => {
  const pm = fakeManager();
  const ownedByA = new Set<string>();

  // While run A's tool call is executing, A, the operator and another agent each start a process.
  pm.start('a-server', 'agent-a');
  pm.start('operator-watcher');
  pm.start('unit-b-server', 'agent-b');
  claimStartedProcesses(pm.manager, 'agent-a', ownedByA);

  cleanupLeakedProcesses(pm.manager, ownedByA);
  expect(pm.stopped).toEqual(['a-server']);
  expect([...pm.running.keys()].sort()).toEqual(['operator-watcher', 'unit-b-server']);
});

test('a run that started nothing stops nothing', () => {
  const pm = fakeManager();
  pm.start('someone-elses');
  cleanupLeakedProcesses(pm.manager, new Set());
  expect(pm.stopped).toEqual([]);
});

test('the process manager records which sub-agent call started a process', async () => {
  const { ProcessManager: Manager } = await import('../platform/src/platform/tools/shared/process-manager.js');
  const { withCallingAgent } = await import('../platform/src/platform/agents/calling-agent.js');
  const manager = new Manager();
  try {
    const inAgent = await withCallingAgent('agent-a', () => manager.spawn('printf a', undefined, undefined));
    const byOperator = await manager.spawn('printf op', undefined, undefined);
    const listed = new Map(manager.list().map((p) => [p.id, p.startedBy]));
    expect(listed.get(inAgent.process_id!)).toBe('agent-a');
    expect(listed.get(byOperator.process_id!)).toBeUndefined();
  } finally { await manager.close(); }
});
