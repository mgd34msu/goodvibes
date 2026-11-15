import { describe, expect, test } from 'bun:test';
import { createAgentKeepAwakeForwarder } from '../../runtime/keep-awake-forward.ts';

const connection = { baseUrl: 'http://127.0.0.1:1', token: 'x' };

function forwarder(options: {
  adopted?: boolean;
  setting?: () => boolean;
  post?: (enabled: boolean) => Promise<unknown>;
}) {
  const lines: string[] = [];
  const posts: boolean[] = [];
  const instance = createAgentKeepAwakeForwarder({
    readKeepAwake: options.setting ?? (() => true),
    isAdopted: () => options.adopted ?? true,
    resolveConnection: () => connection,
    post: (async (_conn: unknown, enabled: boolean) => {
      posts.push(enabled);
      return options.post ? options.post(enabled) : { ok: true, keepAwakeState: 'held' };
    }) as never,
    notify: (line) => lines.push(line),
  });
  return { instance, lines, posts };
}

describe('keep-awake forward to the adopted daemon', () => {
  test('a daemon that held the toggle says nothing; one the OS refused, or one that failed, is reported', async () => {
    const held = forwarder({});
    await held.instance.set(true);
    expect(held.lines).toEqual([]);

    const refused = forwarder({ post: async () => ({ ok: true, keepAwakeState: 'refused' }) });
    await refused.instance.set(true);
    expect(refused.lines[0]).toContain('can still sleep');

    const failed = forwarder({ post: async () => ({ ok: false, kind: 'connected_host_error', error: 'HTTP 500' }) });
    await failed.instance.set(true);
    expect(failed.lines[0]).toContain('HTTP 500');
  });

  test('with no daemon adopted nothing is sent; a toggle says so, the re-send on attach does not', async () => {
    const away = forwarder({ adopted: false });
    await away.instance.set(true);
    await away.instance.attached();
    expect(away.posts).toEqual([]);
    expect(away.lines).toHaveLength(1);
  });

  test('an off set while an earlier forward is in flight is not followed by a late on', async () => {
    let setting = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const { instance, posts } = forwarder({
      setting: () => setting,
      post: async () => { if (first) { first = false; await gate; } return { ok: true, keepAwakeState: 'held' }; },
    });
    const inFlight = instance.set(true);
    const resend = instance.attached();
    setting = false;
    const off = instance.set(false);
    release();
    await Promise.all([inFlight, resend, off]);
    expect(posts).toEqual([true, false, false]);
  });
});
