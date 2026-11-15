import { expect, test } from 'bun:test';
import { AgentsPanel } from '../platform/src/platform/runtime/diagnostics/panels/agents.ts';
import type { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

type Listener = (envelope: { ts: number; traceId: string; sessionId: string; payload: Record<string, unknown> }) => void;

function harness(bufferLimit = 100) {
  let listener: Listener | null = null;
  let unsubscribed = 0;
  const bus = {
    onDomain: (_domain: string, next: Listener) => { listener = next; return () => { unsubscribed += 1; }; },
  } as unknown as RuntimeEventBus;
  const panel = new AgentsPanel(bus, { bufferLimit } as never);
  let ts = 0;
  const emit = (payload: Record<string, unknown>): void => { ts += 1; listener!({ ts, traceId: 't', sessionId: 's', payload }); };
  return { panel, emit, unsubscribed: () => unsubscribed };
}

const spawn = (agentId: string) => ({ type: 'AGENT_SPAWNING', agentId, task: `task ${agentId}` });

test('a woken agent moves from history back to the live list', () => {
  const { panel, emit } = harness();
  emit(spawn('a1'));
  emit({ type: 'AGENT_RUNNING', agentId: 'a1' });
  emit({ type: 'AGENT_COMPLETED', agentId: 'a1', durationMs: 5 });
  expect(panel.getSnapshot().map((entry) => entry.state)).toEqual(['completed']);

  emit({ type: 'AGENT_RUNNING', agentId: 'a1', wake: true });
  const snapshot = panel.getSnapshot();
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]).toMatchObject({ agentId: 'a1', state: 'running', completedAt: undefined, durationMs: undefined, error: undefined });
});

test('an unmarked running event for a finished agent does not resurrect it', () => {
  const { panel, emit } = harness();
  emit(spawn('a1'));
  emit({ type: 'AGENT_FAILED', agentId: 'a1', error: 'boom', durationMs: 1 });
  emit({ type: 'AGENT_RUNNING', agentId: 'a1' });
  expect(panel.getSnapshot().map((entry) => entry.state)).toEqual(['failed']);
});

test('a finished agent does not keep the tool it was last blocked on', () => {
  const { panel, emit } = harness();
  emit(spawn('a1'));
  emit({ type: 'AGENT_AWAITING_TOOL', agentId: 'a1', callId: 'c1', tool: 'exec' });
  emit({ type: 'AGENT_CANCELLED', agentId: 'a1' });
  expect(panel.getSnapshot()[0]).toMatchObject({ state: 'cancelled', blockedOnTool: undefined, blockedOnCallId: undefined });
});

test('agents whose terminal event never arrives are retired, not kept live forever', () => {
  const { panel, emit } = harness(2);
  emit(spawn('a1'));
  emit(spawn('a2'));
  emit(spawn('a3'));
  const byId = Object.fromEntries(panel.getSnapshot().map((entry) => [entry.agentId, entry]));
  expect(byId['a1']!.error).toContain('no terminal event');
  expect(byId['a2']!.error).toBeUndefined();
  expect(byId['a3']!.error).toBeUndefined();
});

test('dispose releases the subscription and clears what the panel held', () => {
  const { panel, emit, unsubscribed } = harness();
  emit(spawn('a1'));
  panel.dispose();
  expect(unsubscribed()).toBe(1);
  expect(panel.getSnapshot()).toEqual([]);
});
