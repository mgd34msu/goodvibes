import { afterEach, expect, test } from 'bun:test';
import { ToolCallsPanel } from '../platform/src/platform/runtime/diagnostics/panels/tool-calls.ts';
import { TasksPanel } from '../platform/src/platform/runtime/diagnostics/panels/tasks.ts';
import { EventsPanel } from '../platform/src/platform/runtime/diagnostics/panels/events.ts';
import { OpsPanel } from '../platform/src/platform/runtime/diagnostics/panels/ops.ts';
import { TransportPanel } from '../platform/src/platform/runtime/diagnostics/panels/transport.ts';
import { PolicyPanel } from '../platform/src/platform/runtime/diagnostics/panels/policy.ts';
import { StateInspectorPanel } from '../platform/src/platform/runtime/diagnostics/panels/state-inspector.ts';
import { applyFilter } from '../platform/src/platform/runtime/diagnostics/types.ts';
import type { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import type { PolicyRegistry } from '../platform/src/platform/runtime/permissions/policy-registry.ts';
import { registerProfileRedactionValues } from '../platform/src/platform/utils/redaction.ts';

type Listener = (envelope: { ts: number; traceId: string; sessionId: string; payload: Record<string, unknown> }) => void;

function harness<T>(make: (bus: RuntimeEventBus) => T) {
  let listener: Listener | null = null;
  const bus = { onDomain: (_domain: string, next: Listener) => { listener = next; return () => undefined; } } as unknown as RuntimeEventBus;
  const panel = make(bus);
  let ts = 0;
  const emit = (payload: Record<string, unknown>, sessionId = 's'): void => { ts += 1; listener!({ ts, traceId: 't', sessionId, payload }); };
  return { panel, emit };
}

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length > 0) restore.pop()!(); });

const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

test('tool calls whose terminal event never arrives are retired, not kept running forever', () => {
  const { panel, emit } = harness((bus) => new ToolCallsPanel(bus, { bufferLimit: 2 } as never));
  for (const id of ['c1', 'c2', 'c3']) emit({ type: 'TOOL_RECEIVED', callId: id, turnId: 'turn', tool: 'exec', args: {} });
  const byId = Object.fromEntries(panel.getSnapshot().map((entry) => [entry.callId, entry]));
  expect(byId['c1']!.error).toContain('no terminal event');
  expect(byId['c2']!.error).toBeUndefined();
  expect(byId['c3']!.error).toBeUndefined();
});

test('tool call arguments are masked and bounded where they are captured', () => {
  const { panel, emit } = harness((bus) => new ToolCallsPanel(bus));
  emit({ type: 'TOOL_RECEIVED', callId: 'c1', turnId: 'turn', tool: 'exec', args: { header: `Authorization: ${TOKEN}`, path: '/tmp/x' } });
  emit({ type: 'TOOL_RECEIVED', callId: 'c2', turnId: 'turn', tool: 'write', args: { content: 'x'.repeat(100_000) } });
  const byId = Object.fromEntries(panel.getSnapshot().map((entry) => [entry.callId, entry]));
  expect(JSON.stringify(byId['c1']!.args)).not.toContain(TOKEN);
  expect(byId['c1']!.args['path']).toBe('/tmp/x');
  expect(JSON.stringify(byId['c2']!.args).length).toBeLessThan(1000);
});

test('tasks whose terminal event never arrives are retired, not kept live forever', () => {
  const { panel, emit } = harness((bus) => new TasksPanel(bus, { bufferLimit: 2 } as never));
  for (const id of ['t1', 't2', 't3']) emit({ type: 'TASK_CREATED', taskId: id, description: id, priority: 1 });
  const byId = Object.fromEntries(panel.getSnapshot().map((entry) => [entry.taskId, entry]));
  expect(byId['t1']!.error).toContain('no terminal event');
  expect(byId['t3']!.error).toBeUndefined();
});

test('a filter on taskId, turnId or domains returns only the rows it names', () => {
  const tasks = harness((bus) => new TasksPanel(bus));
  tasks.emit({ type: 'TASK_CREATED', taskId: 't1', description: 'one', priority: 1 });
  tasks.emit({ type: 'TASK_CREATED', taskId: 't2', description: 'two', priority: 1 });
  expect(tasks.panel.getSnapshot({ taskId: 't1' }).map((e) => e.taskId)).toEqual(['t1']);

  const calls = harness((bus) => new ToolCallsPanel(bus));
  calls.emit({ type: 'TOOL_RECEIVED', callId: 'c1', turnId: 'a', tool: 'x', args: {} });
  calls.emit({ type: 'TOOL_RECEIVED', callId: 'c2', turnId: 'b', tool: 'x', args: {} });
  expect(calls.panel.getSnapshot({ turnId: 'b' }).map((e) => e.callId)).toEqual(['c2']);

  const rows = [
    { sessionId: 's', traceId: 't', domain: 'tools', ts: 1 },
    { sessionId: 's', traceId: 't', domain: 'agents', ts: 2 },
  ];
  expect(applyFilter(rows, { domains: ['agents'] }, (r) => r.ts)).toEqual([rows[1]!]);
});

test('a level filter names a field no entry carries, so it matches nothing rather than everything', () => {
  const rows = [{ sessionId: 's', traceId: 't', ts: 1 }];
  expect(applyFilter(rows, { level: 'warn' }, (r) => r.ts)).toEqual([]);
  const leveled = [{ sessionId: 's', traceId: 't', ts: 1, level: 'debug' }, { sessionId: 's', traceId: 't', ts: 2, level: 'error' }];
  expect(applyFilter(leveled, { level: 'warn' }, (r) => r.ts).map((r) => r.level)).toEqual(['error']);
});

test('a filtered view is capped at the panel buffer limit, not a fixed 500', () => {
  const rows = Array.from({ length: 600 }, (_, ts) => ({ sessionId: 's', traceId: 't', ts }));
  expect(applyFilter(rows, { sessionId: 's' }, (r) => r.ts)).toHaveLength(500);
  expect(applyFilter(rows, { sessionId: 's' }, (r) => r.ts, 600)).toHaveLength(600);
});

test('the events panel applies the same filter rules, including the panel buffer limit', () => {
  const { panel, emit } = harness((bus) => new EventsPanel(bus, { bufferLimit: 3 } as never));
  for (let i = 0; i < 3; i += 1) emit({ type: 'X', turnId: `turn${i}` });
  expect(panel.getSnapshot({ sessionId: 's' })).toHaveLength(3);
  expect(panel.getSnapshot({ level: 'error' })).toEqual([]);
});

test('the transport panel keeps only the most recently seen connections', () => {
  const panel = new TransportPanel({ bufferLimit: 2 } as never);
  const protocol = (id: string) => ({
    version: { label: 'v1' }, downgraded: false, offeredVersion: { label: 'v1' }, peerVersion: { label: 'v1' }, negotiatedAt: 1, id,
  });
  for (const id of ['c1', 'c2', 'c3']) panel.recordSuccess(id, 'wss://x', protocol(id) as never);
  expect(panel.getAll().map((snap) => snap.connectionId).sort()).toEqual(['c2', 'c3']);
});

test('the policy panel snapshot reads audit, lint and simulation sources at snapshot time', () => {
  const registry = { getCurrent: () => null, getCandidate: () => null, getHistory: () => [], diff: () => null } as unknown as PolicyRegistry;
  let audit: unknown[] = [];
  let summary: unknown = null;
  const panel = new PolicyPanel(registry, null, () => audit as never, [], () => summary as never);
  expect(panel.getSnapshot().recentPermissionAudit).toEqual([]);
  audit = [{ id: 'a1' }];
  summary = { ran: true };
  const later = panel.getSnapshot();
  expect(later.recentPermissionAudit).toEqual([{ id: 'a1' } as never]);
  expect(later.lastSimulationSummary).toEqual({ ran: true } as never);
});

test('the state inspector masks credentials in domain state and leaves other state readable', () => {
  const panel = new StateInspectorPanel([{
    name: 'permissions', getRevision: () => 1, getLastUpdatedAt: () => 1,
    getState: () => ({ pending: [{ tool: 'exec', args: { env: `API_KEY=${TOKEN}` } }], count: 1 }),
  }]);
  const snapshot = panel.getSnapshot();
  const text = JSON.stringify(snapshot.domains);
  expect(text).not.toContain(TOKEN);
  expect(snapshot.domains[0]!.state['count']).toBe(1);
  expect(text).toContain('exec');
});

test('a domain whose state cannot be masked is left out with an issue, never shown unmasked', () => {
  restore.push(registerProfileRedactionValues(() => { throw new Error('profile unavailable'); }));
  const panel = new StateInspectorPanel([{
    name: 'permissions', getRevision: () => 1, getLastUpdatedAt: () => 1, getState: () => ({ token: TOKEN }),
  }]);
  const snapshot = panel.getSnapshot();
  expect(snapshot.domains).toEqual([]);
  expect(snapshot.issues?.[0]?.code).toBe('domain_snapshot_failed');
});

test('the ops panel records audit envelopes, newest first, and honours the buffer limit', () => {
  let listener: ((envelope: { ts: number; traceId?: string; sessionId?: string; payload: Record<string, unknown> }) => void) | null = null;
  const feed = { onEnvelope: (_type: string, next: typeof listener) => { listener = next; return () => undefined; } };
  const panel = new OpsPanel(feed as never, { bufferLimit: 2 } as never);
  for (const [ts, targetId] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
    listener!({ ts, sessionId: 's', traceId: 't', payload: { action: 'task.cancel', targetId, targetKind: 'task', reason: 'operator', outcome: 'success' } });
  }
  expect(panel.getSnapshot().map((entry) => entry.targetId)).toEqual(['c', 'b']);
  expect(panel.getSnapshot({ since: 3 }).map((entry) => entry.targetId)).toEqual(['c']);
  panel.dispose();
});
