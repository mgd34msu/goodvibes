import { expect, test } from 'bun:test';
import {
  DiagnosticActionDispatcher,
  buildCancelAgentAction,
  type DiagnosticAction,
} from '../platform/src/platform/runtime/diagnostics/actions.ts';
import type { DeterministicReplayEngine } from '../platform/src/platform/core/deterministic-replay.ts';
import type { OpsControlPlane } from '../platform/src/platform/runtime/ops/control-plane.ts';

const denyOperator = (required: string): boolean => required === 'read';

function controlPlane() {
  const cancelled: string[] = [];
  const plane = {
    canCancelAgent: () => true, cancelAgent: (id: string) => { cancelled.push(id); },
    canCancelTask: () => true, cancelTask: (id: string) => { cancelled.push(id); },
    canRetryTask: () => true, retryTask: (id: string) => { cancelled.push(id); },
  } as unknown as OpsControlPlane;
  return { plane, cancelled };
}

test('the tier an action needs comes from its type, not from the permission the action object claims', async () => {
  const { plane, cancelled } = controlPlane();
  const dispatcher = new DiagnosticActionDispatcher({ controlPlane: plane, checkPermission: denyOperator });
  const forged = { ...buildCancelAgentAction('a1'), permission: 'read' } as DiagnosticAction;
  const result = await dispatcher.dispatch(forged);
  expect(result).toMatchObject({ success: false, permissionDenied: true });
  expect(result.message).toContain("'operator'");
  expect(cancelled).toEqual([]);
});

test('a navigation action still needs only the read tier', async () => {
  const visited: string[] = [];
  const dispatcher = new DiagnosticActionDispatcher({ navigateTo: (target, id) => { visited.push(`${target}:${id}`); }, checkPermission: denyOperator });
  const result = await dispatcher.dispatch({ type: 'jump-to-task', permission: 'operator', label: 'Jump', payload: { taskId: 't1' } });
  expect(result.success).toBe(true);
  expect(visited).toEqual(['task:t1']);
});

test('a jump with no navigation handler reports that nothing happened', async () => {
  const dispatcher = new DiagnosticActionDispatcher({});
  const result = await dispatcher.dispatch({ type: 'jump-to-agent', permission: 'read', label: 'Jump', payload: { agentId: 'a1' } });
  expect(result.success).toBe(false);
  expect(result.message).toContain('no navigation handler');
});

function replayEngine() {
  const calls: string[] = [];
  const engine = {
    reset: () => { calls.push('reset'); },
    load: (runId: string, _snapshot: unknown, entries: unknown[]) => { calls.push(`load ${runId} ${entries.length}`); },
  } as unknown as DeterministicReplayEngine;
  return { engine, calls };
}
const loadAction: DiagnosticAction = { type: 'load-replay', permission: 'operator', label: 'Load', payload: { runId: 'run-1' } };

test('load-replay loads the run through the loader and says how many entries it holds', async () => {
  const { engine, calls } = replayEngine();
  const dispatcher = new DiagnosticActionDispatcher({
    replayEngine: engine,
    loadReplayRun: (runId) => runId === 'run-1' ? { snapshot: { capturedAt: 1, domains: [] }, entries: [{} as never, {} as never] } : undefined,
  });
  const result = await dispatcher.dispatch(loadAction);
  expect(result).toMatchObject({ success: true });
  expect(calls).toEqual(['load run-1 2']);
});

test('load-replay with no loader fails and leaves the loaded replay untouched', async () => {
  const { engine, calls } = replayEngine();
  const result = await new DiagnosticActionDispatcher({ replayEngine: engine }).dispatch(loadAction);
  expect(result.success).toBe(false);
  expect(calls).toEqual([]);
});

test('load-replay for an unknown run fails and leaves the loaded replay untouched', async () => {
  const { engine, calls } = replayEngine();
  const result = await new DiagnosticActionDispatcher({ replayEngine: engine, loadReplayRun: () => undefined }).dispatch(loadAction);
  expect(result.success).toBe(false);
  expect(result.message).toContain('not found');
  expect(calls).toEqual([]);
});
