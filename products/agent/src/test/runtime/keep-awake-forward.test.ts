import { describe, expect, test } from 'bun:test';
import { createKeepAwakeForwardQueue, forwardKeepAwakeWithNotice, queueKeepAwakeResend } from '../../runtime/keep-awake-forward.ts';

const connection = { baseUrl: 'http://127.0.0.1:1', token: 'x' };

function run(enabled: boolean, reachable: 'online' | 'offline', post: () => Promise<never> | Promise<unknown>, tellWhenUnreachable?: boolean) {
  const lines: string[] = [];
  return forwardKeepAwakeWithNotice(enabled, {
    probeReachability: async () => reachable,
    resolveConnection: () => connection,
    post: post as never,
    notify: (line) => lines.push(line),
    ...(tellWhenUnreachable === undefined ? {} : { tellWhenUnreachable }),
  }).then(() => lines);
}

describe('keep-awake forward to the adopted daemon', () => {
  test('a daemon that held the toggle says nothing', async () => {
    expect(await run(true, 'online', async () => ({ ok: true, keepAwakeState: 'held' }))).toEqual([]);
  });

  test('a daemon that accepted the toggle but was refused by the OS is reported', async () => {
    const lines = await run(true, 'online', async () => ({ ok: true, keepAwakeState: 'refused' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('can still sleep');
  });

  test('a failed forward names the reason and that the hold will not outlive the process', async () => {
    const lines = await run(true, 'online', async () => ({ ok: false, kind: 'connected_host_error', error: 'HTTP 500' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('HTTP 500');
    expect(lines[0]).toContain('will not outlive');
  });

  test('an unreachable daemon is reported for a toggle but not for the re-send on attach', async () => {
    const never = async () => { throw new Error('must not post'); };
    expect(await run(true, 'offline', never)).toHaveLength(1);
    expect(await run(true, 'offline', never, false)).toEqual([]);
  });
});

describe('keep-awake forward queue', () => {
  test('an on re-send in flight finishes before an off set meanwhile, and reads the setting at its own turn', async () => {
    const queue = createKeepAwakeForwardQueue();
    const sent: string[] = [];
    let setting = true;
    let releaseFirst: () => void = () => {};
    const first = queue.run(async () => {
      sent.push('on:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      sent.push('on:end');
    });
    // The owner turns it off while the first forward is still awaiting the daemon.
    setting = false;
    const second = queue.run(async () => { sent.push('off'); });
    // A re-send queued after the off reads the setting at its turn and sends nothing.
    const resend = queue.run(async () => { if (setting) sent.push('on:resend'); });
    await Promise.resolve();
    expect(sent).toEqual(['on:start']);
    releaseFirst();
    await Promise.all([first, second, resend]);
    expect(sent).toEqual(['on:start', 'on:end', 'off']);
  });

  test('a failed step does not stop the ones behind it', async () => {
    const queue = createKeepAwakeForwardQueue();
    const failed = queue.run(async () => { throw new Error('boom'); });
    await expect(failed).rejects.toThrow('boom');
    expect(await queue.run(async () => 'next')).toBe('next');
  });
});

describe('keep-awake re-send on attach', () => {
  function resendDeps(posts: boolean[], gate?: Promise<void>) {
    return {
      probeReachability: async () => 'online' as const,
      resolveConnection: () => connection,
      post: (async (_conn: unknown, enabled: boolean) => {
        if (gate) await gate;
        posts.push(enabled);
        return { ok: true, keepAwakeState: 'held' };
      }) as never,
    };
  }

  test('an off set while an earlier forward is in flight is not followed by a late on', async () => {
    const queue = createKeepAwakeForwardQueue();
    const posts: boolean[] = [];
    let setting = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = queue.run(() => forwardKeepAwakeWithNotice(true, resendDeps(posts, gate)));
    const resend = queueKeepAwakeResend(queue, () => setting, resendDeps(posts));
    setting = false;
    const off = queue.run(() => forwardKeepAwakeWithNotice(false, resendDeps(posts)));
    release();
    await Promise.all([inFlight, resend, off]);
    expect(posts).toEqual([true, false]);
  });

  test('an on toggle in flight is sent before the re-send, then the off', async () => {
    const queue = createKeepAwakeForwardQueue();
    const posts: boolean[] = [];
    let setting = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const toggleOn = queue.run(() => forwardKeepAwakeWithNotice(true, resendDeps(posts, gate)));
    const resend = queueKeepAwakeResend(queue, () => setting, resendDeps(posts));
    const toggleOff = queue.run(() => { setting = false; return forwardKeepAwakeWithNotice(false, resendDeps(posts)); });
    release();
    await Promise.all([toggleOn, resend, toggleOff]);
    expect(posts).toEqual([true, true, false]);
  });
});
