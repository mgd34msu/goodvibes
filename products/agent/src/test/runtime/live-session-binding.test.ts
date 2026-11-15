import { describe, expect, test } from 'bun:test';
import { moveLiveSession } from '../../runtime/live-session-binding.ts';
import { createHostedSessionRegistry } from '@goodvibes-jev/engine/terminal-shell/hosted-session-registry';

function harness(boot: string) {
  const calls: string[] = [];
  const ref = { value: boot };
  const hosted = createHostedSessionRegistry();
  hosted.adopt(boot);
  const conversation = { name: 'conversation' };
  const deps = {
    ref,
    hostedSessions: hosted,
    conversation,
    registerConversation: (id: string, c: typeof conversation) => { calls.push(`register:${id}:${c.name}`); },
    unregisterConversation: (id: string) => { calls.push(`unregister:${id}`); },
    rewindHost: { start: (id: string) => { calls.push(`rewind:${id}`); } },
    spine: { reopen: (input: { sessionId: string; project: string }) => { calls.push(`reopen:${input.sessionId}:${input.project}`); } },
    project: '/work',
  };
  return { deps, ref, hosted, calls };
}

describe('moveLiveSession', () => {
  test('a resume moves the ref, the hosted set, the rewind registry and host, and the spine to the new id', () => {
    const { deps, ref, hosted, calls } = harness('boot');
    moveLiveSession(deps, 'resumed');
    expect(ref.value).toBe('resumed');
    expect(hosted.hosts('resumed')).toBe(true);
    expect(hosted.hosts('boot')).toBe(false);
    expect([...hosted.ids()]).toEqual(['resumed']);
    expect(calls).toEqual(['unregister:boot', 'register:resumed:conversation', 'rewind:resumed', 'reopen:resumed:/work']);
  });

  test('assigning the id already in use changes nothing', () => {
    const { deps, calls, hosted } = harness('boot');
    moveLiveSession(deps, 'boot');
    expect(calls).toEqual([]);
    expect([...hosted.ids()]).toEqual(['boot']);
  });
});
