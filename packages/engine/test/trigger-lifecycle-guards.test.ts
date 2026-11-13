/** reset() and cancel() honour the declared trigger lifecycle. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TriggerManager, type TriggerProcessHost, type TriggerStreamHost } from '../platform/src/platform/triggers/index.ts';
import { checkReset, triggerLifecycle } from '../platform/src/platform/triggers/supervision.ts';

const roots: string[] = [], managers: TriggerManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) { m.shutdown(); await m.join(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const streamDef = { id: 'stream', label: 'Events', spec: { kind: 'stream', command: 'x', match: { kind: 'regex', pattern: 'E' }, batchLines: 1 }, action: { kind: 'agent-turn' } } as const;

function streamFixture() {
  const root = mkdtempSync(join(tmpdir(), 'trig-lc-')); roots.push(root);
  let now = 1000;
  const starts: Parameters<TriggerStreamHost['start']>[0][] = [];
  const host: TriggerStreamHost = { async start(i) { starts.push(i); return { streamId: `s${starts.length}`, pid: starts.length }; }, stop() {} };
  const manager = new TriggerManager({ storePath: join(root, 't.json'), streamHost: host, now: () => now,
    config: () => ({ enabled: true, backoffLadderMs: '100,200', breakerStrikes: 3 }),
    actions: { async runAgentTurn() { return 'done'; }, async runGrant() { return ''; } } });
  managers.push(manager);
  return { manager, starts };
}

test('reset refuses a running trigger and leaves it untouched', async () => {
  const f = streamFixture(); await f.manager.create(streamDef);
  expect(f.manager.get('stream')?.state).toBe('running');
  expect(f.manager.reset('stream')).toBeNull();
  expect(f.manager.get('stream')?.state).toBe('running');
  expect(f.manager.resetRefusal('stream')).toContain('running');
});

test('reset refuses a cancelled trigger; cancel twice is a no-op', async () => {
  const f = streamFixture(); await f.manager.create(streamDef);
  const first = f.manager.cancel('stream');
  const runs = first!.runs.length;
  expect(f.manager.cancel('stream')?.runs.length).toBe(runs);
  expect(f.manager.reset('stream')).toBeNull();
  expect(f.manager.get('stream')?.state).toBe('cancelled');
});

test('reset still clears a backoff trigger; checkReset reasons name what is possible', async () => {
  const f = streamFixture(); await f.manager.create(streamDef);
  f.starts[0]!.onExit(1);
  expect(f.manager.get('stream')?.state).toBe('backoff');
  expect(f.manager.reset('stream')?.state).toBe('idle');
  const refused = checkReset({ state: 'cancelled' });
  expect(refused.ok).toBe(false);
  expect(triggerLifecycle.can('cancelled', 'idle')).toBe(false);
});

test('cancel does not turn a fired on-exit trigger into cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trig-lc-')); roots.push(root);
  let finished = false;
  const host: TriggerProcessHost = {
    launch: async () => ({ processId: 'p1', pid: 1, startedAt: 1000 }),
    observe: () => finished ? { running: false, exitCode: 0, signal: null, timedOut: false, stdoutTail: '', stderrTail: '', endedAt: 2000 } : { running: true, exitCode: null, signal: null, timedOut: false, stdoutTail: '', stderrTail: '' },
    cancel() {}, isSameProcessAlive: () => true,
  };
  const manager = new TriggerManager({ storePath: join(root, 't.json'), config: { enabled: true, onExitMaxDurationMs: 60_000, outputTailBytes: 64 },
    actions: { async runAgentTurn() { return 'ok'; }, async runGrant() { return ''; } }, processHost: host, daemonBootId: 'b', now: () => 1000 });
  managers.push(manager);
  await manager.create({ id: 'x', label: 'X', spec: { kind: 'on-exit', command: 'make', args: [] }, action: { kind: 'agent-turn', prompt: '' }, createdAt: 0 });
  finished = true; await manager.pollProcesses();
  expect(manager.get('x')?.state).toBe('fired');
  expect(manager.cancel('x')?.state).toBe('fired');
  expect(manager.reset('x')).toBeNull();
});
