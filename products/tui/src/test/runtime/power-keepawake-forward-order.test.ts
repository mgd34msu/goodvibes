/**
 * The keep-awake forward is the only thing that makes the toggle outlive this
 * terminal, so it is applied in toggle order and a daemon that does not take it
 * is reported to the owner.
 */
import { describe, expect, test } from 'bun:test';
import { forwardKeepAwakeToDaemon, installKeepAwakeRemoteForward, resendKeepAwakeOnReconnect } from '../../runtime/power-keepawake-remote.ts';

function config() {
  const subs: Array<(value: unknown) => void> = [];
  const configManager = {
    get: () => undefined,
    subscribe: (_key: string, callback: (value: unknown) => void) => { subs.push(callback); return () => {}; },
  } as never;
  return { configManager, fire: (value: unknown) => subs[0]!(value) };
}

describe('keep-awake forwarding', () => {
  test('two quick toggles reach the daemon one after the other, in order', async () => {
    const { configManager, fire } = config();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const resolveRpc = (() => ({
      available: true,
      platformClient: {
        operator: {
          invoke: async (_id: string, input: { enabled: boolean }) => {
            const call = ++calls;
            order.push(`start:${input.enabled}`);
            if (call === 1) await firstGate;
            order.push(`end:${input.enabled}`);
            return {};
          },
        },
      },
    })) as never;
    installKeepAwakeRemoteForward({ configManager, homeDirectory: '/h', isExternalDaemon: () => true, resolveRpc });

    fire(true);
    fire(false);
    await Promise.resolve();
    expect(order).toEqual(['start:true']);

    releaseFirst();
    await new Promise<void>((resolve) => { const check = (): void => { if (order.length >= 4) resolve(); else queueMicrotask(check); }; check(); });
    expect(order).toEqual(['start:true', 'end:true', 'start:false', 'end:false']);
  });

  test('a daemon that refuses the toggle is reported, naming the state and the reason', async () => {
    const lines: string[] = [];
    const resolveRpc = (() => ({
      available: true,
      platformClient: { operator: { invoke: async () => { throw new Error('daemon said no'); } } },
    })) as never;

    await forwardKeepAwakeToDaemon(true, {
      configManager: config().configManager, homeDirectory: '/h', isExternalDaemon: () => true, resolveRpc, notify: (line) => lines.push(line),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('on in this terminal only');
    expect(lines[0]).toContain('daemon said no');
  });

  test('a daemon that cannot be resolved is reported with its reason, and an embedded daemon says nothing', async () => {
    const lines: string[] = [];
    const resolveRpc = (() => ({ available: false, reason: 'the daemon is disabled' })) as never;
    const base = { configManager: config().configManager, homeDirectory: '/h', resolveRpc, notify: (line: string) => lines.push(line) };

    await forwardKeepAwakeToDaemon(false, { ...base, isExternalDaemon: () => true });
    await forwardKeepAwakeToDaemon(false, { ...base, isExternalDaemon: () => false });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the daemon is disabled');
  });
});

describe('keep-awake the daemon accepted but the host refused, and a daemon that comes up later', () => {
  test('a refused hold is reported even though the request succeeded', async () => {
    const lines: string[] = [];
    const resolveRpc = (() => ({
      available: true,
      platformClient: { operator: { invoke: async () => ({ keepAwake: { enabled: true, held: false, state: 'refused' } }) } },
    })) as never;
    await forwardKeepAwakeToDaemon(true, {
      configManager: config().configManager, homeDirectory: '/h', isExternalDaemon: () => true, resolveRpc, notify: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('can still sleep');
  });

  test('keep-awake that is on is re-sent when the daemon turns reachable, once, and off is never re-sent', async () => {
    const sent: boolean[] = [];
    const resolveRpc = (() => ({
      available: true,
      platformClient: { operator: { invoke: async (_id: string, input: { enabled: boolean }) => { sent.push(input.enabled); return {}; } } },
    })) as never;
    let keepAwake: unknown = true;
    let reachable = false;
    const configManager = { get: () => keepAwake, subscribe: () => () => {} } as never;
    const deps = { configManager, homeDirectory: '/h', isExternalDaemon: () => true, resolveRpc };
    const fetch = resendKeepAwakeOnReconnect(deps, async () => (reachable ? ({} as never) : null));
    const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

    await fetch(); await settle();
    expect(sent).toEqual([]); // daemon not reachable yet

    reachable = true;
    await fetch(); await fetch(); await settle();
    expect(sent).toEqual([true]); // first reachable poll only

    reachable = false; await fetch();
    reachable = true; keepAwake = false;
    await fetch(); await settle();
    expect(sent).toEqual([true]); // off is left to whoever turned it off
  });
});
