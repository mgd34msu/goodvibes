import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { HookDispatcher, type HookEvent } from '@goodvibes-jev/engine/platform/platform/hooks';
import { TriggerManager } from '@goodvibes-jev/engine/platform/platform/tools';

type Spawned = { readonly command: readonly string[]; readonly triggerId: string | undefined };

let spawned: Spawned[];
let onSpawn: (() => void) | null;
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;

beforeEach(() => {
  spawned = [];
  onSpawn = null;
  spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((command: readonly string[], options: { env: Record<string, string | undefined> }) => {
    spawned.push({ command, triggerId: options.env['GV_TRIGGER_ID'] });
    queueMicrotask(() => onSpawn?.());
    return { pid: 1000 + spawned.length, exited: Promise.resolve(0), kill() {} };
  }) as unknown as typeof Bun.spawn);
});

const managers: TriggerManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.commands.stop();
  spawnSpy.mockRestore();
});

const toolEvent = (specific: string): HookEvent => ({
  path: `Post:tool:${specific}`,
  phase: 'Post' as const,
  category: 'tool' as const,
  specific,
  sessionId: 'trigger-wire-test',
  timestamp: 0,
  payload: {},
});

function track(manager: TriggerManager): TriggerManager { managers.push(manager); return manager; }

/** Resolves once a trigger action has been started. */
function nextSpawn(): Promise<void> {
  return new Promise<void>((resolve) => { onSpawn = resolve; });
}

describe('HookDispatcher trigger wiring', () => {
  test('a fired hook event starts the matching trigger action', async () => {
    const dispatcher = new HookDispatcher();
    const tm = track(new TriggerManager());
    const matching = tm.add({ event: 'Post:tool:*', action: 'echo trigger-fired' });
    dispatcher.setTriggerManager(tm);

    const started = nextSpawn();
    const result = await dispatcher.fire(toolEvent('read'));
    await started;

    expect(result.ok).toBe(true);
    expect(spawned.map((s) => s.triggerId)).toEqual([matching.id]);
  });

  test('disabled triggers and triggers for other events do not fire', async () => {
    const dispatcher = new HookDispatcher();
    const tm = track(new TriggerManager());
    const disabled = tm.add({ event: 'Post:tool:*', action: 'echo disabled' });
    tm.disable(disabled.id);
    tm.add({ event: 'Pre:tool:*', action: 'echo other-phase' });
    // Triggers are evaluated in order, so once this one has started the two
    // above have already been skipped.
    const enabled = tm.add({ event: 'Post:tool:*', action: 'echo enabled' });
    dispatcher.setTriggerManager(tm);

    const started = nextSpawn();
    await dispatcher.fire(toolEvent('read'));
    await started;

    expect(spawned.map((s) => s.triggerId)).toEqual([enabled.id]);
  });

  test('a detached trigger manager is not consulted', async () => {
    const dispatcher = new HookDispatcher();
    const tm = track(new TriggerManager());
    tm.add({ event: 'Post:tool:*', action: 'echo should-not-run' });
    dispatcher.setTriggerManager(tm);
    dispatcher.setTriggerManager(null);

    await dispatcher.fire(toolEvent('read'));
    // A second dispatcher with a manager supplies the positive gate: its spawn
    // proves the first fire had every chance to start its own action.
    const gate = new HookDispatcher();
    const gateTriggers = track(new TriggerManager());
    const gated = gateTriggers.add({ event: 'Post:tool:*', action: 'echo gate' });
    gate.setTriggerManager(gateTriggers);
    const started = nextSpawn();
    await gate.fire(toolEvent('read'));
    await started;

    expect(spawned.map((s) => s.triggerId)).toEqual([gated.id]);
  });

  test('the hook result is unaffected by a failing trigger action', async () => {
    const dispatcher = new HookDispatcher();
    const tm = track(new TriggerManager());
    tm.add({ event: 'Post:tool:*', action: 'echo side-effect' });
    dispatcher.setTriggerManager(tm);
    spawnSpy.mockImplementation((() => { throw new Error('spawn refused'); }) as unknown as typeof Bun.spawn);

    const result = await dispatcher.fire(toolEvent('write'));

    expect(result.ok).toBe(true);
    expect(result.decision).toBeUndefined();
  });
});
