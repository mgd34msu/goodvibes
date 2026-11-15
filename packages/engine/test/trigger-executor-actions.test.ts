import { afterEach, describe, expect, test } from 'bun:test';
import {
  fireTriggers,
  type TriggerExecutionOptions,
} from '../platform/src/platform/workflow/trigger-executor.ts';
import { AutomationCommands } from '../platform/src/platform/workflow/automation-commands.ts';
import type { HookEvent } from '../platform/src/platform/hooks/types.ts';
import type { TriggerDefinition } from '../platform/src/platform/tools/workflow/index.ts';

const event = (payload: Record<string, unknown> = {}): HookEvent => ({
  path: 'Post:tool:exec', phase: 'Post', category: 'tool', specific: 'exec',
  sessionId: 'synthetic', timestamp: 0, payload,
});
const trigger = (over: Partial<TriggerDefinition>): TriggerDefinition =>
  ({ id: 't1', enabled: true, event: 'Post:tool:exec', action: 'run-it', ...over }) as TriggerDefinition;

interface FakeProc { pid: number; killed: boolean; exited: Promise<number>; kill(): void; finish(code: number): void }
function fakeSpawn() {
  const procs: FakeProc[] = [];
  const envs: Array<Record<string, string | undefined>> = [];
  const spawn = ((_cmd: string[], opts: { env: Record<string, string | undefined> }) => {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    const proc: FakeProc = { pid: 100 + procs.length, killed: false, exited, kill() { proc.killed = true; finish(143); }, finish };
    procs.push(proc);
    envs.push(opts.env);
    return proc;
  }) as unknown as NonNullable<TriggerExecutionOptions['spawn']>;
  return { spawn, procs, envs };
}
let commands = new AutomationCommands();
const run = (t: TriggerDefinition, options: TriggerExecutionOptions, ev = event()) =>
  fireTriggers(ev, { list: () => [t], commands }, options);

afterEach(() => { commands.stop(); commands = new AutomationCommands(); });

describe('trigger conditions with || and &&', () => {
  const passes = async (condition: string, payload: Record<string, unknown>) => {
    const f = fakeSpawn();
    const [r] = await run(trigger({ condition }), { spawn: f.spawn }, event(payload));
    return r?.executed === true;
  };
  test('a true left operand of || still fires', async () => {
    expect(await passes('payload.a === 1 || payload.b === 9', { a: 1, b: 2 })).toBe(true);
    expect(await passes('payload.a === 1 || payload.b === 9', { a: 0, b: 2 })).toBe(false);
  });
  test('false && x || true is true', async () => {
    expect(await passes('payload.a === 9 && payload.b === 2 || payload.b === 2', { a: 1, b: 2 })).toBe(true);
    expect(await passes('payload.a === 9 && payload.b === 2 || payload.b === 3', { a: 1, b: 2 })).toBe(false);
  });
  test('true && false is false and true || false is true', async () => {
    expect(await passes('payload.a === 1 && payload.b === 9', { a: 1, b: 2 })).toBe(false);
    expect(await passes('payload.a === 1 || payload.b === 9', { a: 1, b: 9 })).toBe(true);
  });
});

describe('trigger results', () => {
  test('an unparsable condition names the problem; a non-match has no error', async () => {
    const f = fakeSpawn();
    const [bad] = await run(trigger({ condition: 'payload.a ===' }), { spawn: f.spawn });
    expect(bad?.executed).toBe(false);
    expect(bad?.error).toContain('Condition could not be evaluated');
    const [miss] = await run(trigger({ condition: 'payload.a === 1' }), { spawn: f.spawn }, event({ a: 2 }));
    expect(miss?.executed).toBe(false);
    expect(miss?.error).toBeUndefined();
    expect(f.procs.length).toBe(0);
  });

  test('credential variables are withheld from the action environment', async () => {
    process.env['SYNTHETIC_TRIGGER_API_TOKEN'] = 'secret-value';
    try {
      const f = fakeSpawn();
      await run(trigger({}), { spawn: f.spawn });
      expect(f.envs[0]?.['SYNTHETIC_TRIGGER_API_TOKEN']).toBeUndefined();
      expect(f.envs[0]?.['GV_TRIGGER_ID']).toBe('t1');
    } finally {
      delete process.env['SYNTHETIC_TRIGGER_API_TOKEN'];
    }
  });

  test('a run past the in-flight limit is refused with a reason, and a finished run frees a slot', async () => {
    const f = fakeSpawn();
    const options: TriggerExecutionOptions = { spawn: f.spawn, maxInFlight: 1 };
    const [first] = await run(trigger({}), options);
    expect(first?.executed).toBe(true);
    const [second] = await run(trigger({}), options);
    expect(second?.executed).toBe(false);
    expect(second?.error).toContain('still running');
    f.procs[0]!.finish(0);
    await f.procs[0]!.exited;
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const [third] = await run(trigger({}), options);
    expect(third?.executed).toBe(true);
  });

  test('the timer callback kills a running action', async () => {
    const f = fakeSpawn();
    let fire: (() => void) | undefined;
    await run(trigger({}), { spawn: f.spawn, startTimer: (cb) => { fire = cb; return () => {}; } });
    expect(f.procs[0]!.killed).toBe(false);
    fire!();
    expect(f.procs[0]!.killed).toBe(true);
  });

  test('stopping one runtime\'s commands kills only its own actions', async () => {
    const f = fakeSpawn();
    const other = new AutomationCommands();
    await run(trigger({}), { spawn: f.spawn, startTimer: () => () => {} });
    await fireTriggers(event(), { list: () => [trigger({ id: 't2' })], commands: other }, { spawn: f.spawn, startTimer: () => () => {} });
    other.stop();
    expect(f.procs.map((proc) => proc.killed)).toEqual([false, true]);
    commands.stop();
    expect(f.procs[0]!.killed).toBe(true);
  });

  test('a burst of fires never starts more than the in-flight limit', async () => {
    const f = fakeSpawn();
    // The guard resolves on a later tick, so every fire is past the limit check before any spawns.
    const options: TriggerExecutionOptions = { spawn: f.spawn, maxInFlight: 4, guardCommand: () => new Promise((resolve) => setTimeout(() => resolve(undefined), 0)) };
    const results = (await Promise.all(Array.from({ length: 10 }, () => run(trigger({}), options)))).flat();
    expect(f.procs.length).toBe(4);
    expect(results.filter((r) => r.executed).length).toBe(4);
    expect(results.filter((r) => r.error?.includes('still running')).length).toBe(6);
  });

  test('a command the guard refuses is not started', async () => {
    const f = fakeSpawn();
    const [r] = await run(trigger({}), { spawn: f.spawn, guardCommand: async () => 'blocked' });
    expect(r?.executed).toBe(false);
    expect(r?.error).toContain('blocked');
    expect(f.procs.length).toBe(0);
  });
});
