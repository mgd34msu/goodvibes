/** Authored regression source; execution deferred until coding is complete. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TriggerManager, loadTriggerSnapshot, type TriggerStreamHost } from '../sdk/src/platform/triggers/index.ts';

const roots: string[] = [], managers: TriggerManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.shutdown(); await manager.join(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const definition = { id: 'stream', label: 'Build events', spec: { kind: 'stream', command: 'fixture-stream',
  match: { kind: 'regex', pattern: 'ERROR' }, batchLines: 1 }, action: { kind: 'agent-turn' } } as const;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stream-restarts-')); roots.push(root);
  const path = join(root, 'triggers-v2.json');
  let now = 1000, enabled = true, actions = 0;
  const starts: Parameters<TriggerStreamHost['start']>[0][] = [], stopped: string[] = [];
  const host: TriggerStreamHost = { async start(input) { starts.push(input); return { streamId: `original-${starts.length}`, pid: starts.length }; }, stop(id) { stopped.push(id); } };
  const manager = new TriggerManager({ storePath: path, streamHost: host, now: () => now,
    config: () => ({ enabled, backoffLadderMs: '100,200', breakerStrikes: 3 }),
    actions: { async runAgentTurn() { actions += 1; return 'done'; }, async runGrant() { return ''; } },
  });
  managers.push(manager);
  return { manager, host, starts, stopped, path, advance(ms: number) { now += ms; }, enable(value: boolean) { enabled = value; }, actions: () => actions };
}

test('the actual supervision tick restarts an exited stream at its saved deadline and retires old callbacks', async () => {
  const f = fixture(); await f.manager.create(definition);
  f.starts[0]!.onExit(1); expect(f.manager.get('stream')?.state).toBe('backoff');
  await f.manager.supervisionTick(); expect(f.starts).toHaveLength(1);
  f.advance(100); await f.manager.supervisionTick(); expect(f.starts).toHaveLength(2);
  expect(f.manager.get('stream')?.state).toBe('running');
  f.starts[0]!.onChunk('ERROR retired\n'); f.starts[0]!.onExit(2);
  expect(f.actions()).toBe(0); expect(f.manager.get('stream')?.state).toBe('running');
  f.starts[1]!.onChunk('ERROR current\n'); await f.manager.join(); expect(f.actions()).toBe(1);
});

test('operator inspection of an unclaimed supervisor never creates state or acquires execution', () => {
  const f = fixture(); expect(f.manager.executionOwnership).toBe('unclaimed');
  expect(f.manager.inspectRecords()).toEqual([]); expect(f.manager.executionOwnership).toBe('unclaimed');
  expect(existsSync(f.path)).toBe(false); expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
});

test('overlapping ticks admit one restart and the host observes the durable reservation first', async () => {
  const f = fixture(); await f.manager.create(definition); f.starts[0]!.onExit(1); f.advance(100);
  const returned = Promise.withResolvers<{ streamId: string; pid: number }>(); let launches = 0;
  f.host.start = input => {
    launches += 1; f.starts.push(input);
    const stored = loadTriggerSnapshot(f.path).snapshot?.triggers[0];
    expect(stored?.state).toBe('running'); expect(stored?.lastError).toContain('acknowledgement unobserved');
    return returned.promise;
  };
  const first = f.manager.supervisionTick(), second = f.manager.supervisionTick();
  expect(launches).toBe(1); returned.resolve({ streamId: 'actual-restart', pid: 5 });
  await Promise.all([first, second]); expect(launches).toBe(1); expect(f.manager.get('stream')?.state).toBe('running');
});

test('shutdown drains an entered restart and stops only its actual late returned handle', async () => {
  const f = fixture(); await f.manager.create(definition); f.starts[0]!.onExit(1); f.advance(100);
  const returned = Promise.withResolvers<{ streamId: string; pid: number }>(); f.host.start = () => returned.promise;
  const restarting = f.manager.supervisionTick(); f.manager.shutdown();
  let drained = false; const joined = f.manager.join().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  returned.resolve({ streamId: 'late-original', pid: 8 }); await restarting; await joined;
  expect(f.stopped).toEqual(['late-original']); expect(drained).toBe(true);
});

test('disabled and cancelled streams never restart; restart-disabled stream requires an explicit reset', async () => {
  const f = fixture(); await f.manager.create({ ...definition, spec: { ...definition.spec, restart: false } });
  f.starts[0]!.onExit(0); f.advance(1000); await f.manager.supervisionTick(); expect(f.starts).toHaveLength(1);
  f.manager.reset('stream'); f.enable(false); await f.manager.supervisionTick(); expect(f.starts).toHaveLength(1);
  f.enable(true); await f.manager.supervisionTick(); expect(f.starts).toHaveLength(2);
  f.starts[1]!.onExit(0); f.manager.reset('stream'); f.manager.cancel('stream');
  await f.manager.supervisionTick(); expect(f.starts).toHaveLength(2);
});

test('failed starts walk the existing finite ladder and park at the strike breaker', async () => {
  const f = fixture(); await f.manager.create(definition); f.starts[0]!.onExit(1);
  let attempts = 0; f.host.start = async () => { attempts += 1; throw Error('fixture launch failed'); };
  f.advance(100); await f.manager.supervisionTick(); expect(attempts).toBe(1); expect(f.manager.get('stream')?.state).toBe('backoff');
  f.advance(200); await f.manager.supervisionTick(); expect(attempts).toBe(2); expect(f.manager.get('stream')?.state).toBe('circuit-open');
  f.advance(100000); await f.manager.supervisionTick(); expect(attempts).toBe(2);
});
