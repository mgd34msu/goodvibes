/**
 * A rewind the surface already applied is reported even if the offer is
 * withdrawn meanwhile, a question the daemon stopped waiting for is not applied,
 * and the take loop does not run hot or trade a contested session every few seconds.
 */
import { expect, test } from 'bun:test';
import { clearTurnAnchors, getTurnAnchors, recordTurnAnchor, restoreTurnAnchors } from '../platform/src/platform/rewind/turn-anchors.ts';
import { makeTestSurface } from './_helpers/session-surface.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { rmSync } from 'node:fs';
import { createConversationRewindHost } from '../platform/src/platform/runtime/client/conversation-rewind-host.ts';
import type { DaemonVerbCaller } from '../platform/src/platform/runtime/client/daemon-verbs.ts';
import type { RewindConversationPort } from '../platform/src/platform/rewind/types.ts';

const quiet = { debug: () => {}, info: () => {}, warn: () => {} };
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i += 1) await turn();
  if (!predicate()) throw new Error('did not settle');
}
const parked = (): Promise<never> => new Promise<never>(() => {});
const takenOver = (): Error => Object.assign(new Error('the session is served elsewhere now'), { status: 409, code: 'HOST_TAKEN_OVER' });

function fakeDaemon(take: (call: number, park: () => Promise<never>) => Promise<unknown>) {
  // Like the broker, releasing the host wakes a take that is parked on it.
  const waiting: Array<(error: Error) => void> = [];
  const park = (): Promise<never> => new Promise<never>((_resolve, reject) => { waiting.push(reject); });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let takes = 0;
  const verbs: DaemonVerbCaller = {
    probe: () => ({ available: true }),
    invoke: async <T,>(method: string, input?: unknown): Promise<T> => {
      calls.push({ method, input: (input ?? {}) as Record<string, unknown> });
      if (method === 'rewind.conversation.host.register') return { host: { hostId: `host-${calls.filter((c) => c.method === method).length}` } } as T;
      if (method === 'rewind.conversation.requests.take') { takes += 1; return await take(takes, park) as T; }
      if (method === 'rewind.conversation.host.release') for (const wake of waiting.splice(0)) wake(new Error('host released'));
      return {} as T;
    },
  };
  return { verbs, calls, takes: () => takes };
}

const REQUEST = { requestId: 'r1', sessionId: 's1', turnId: 't1', kind: 'rewind' as const, expiresAt: Number.MAX_SAFE_INTEGER };

test('a rewind applied while the offer is withdrawn is still reported, before the host is released', async () => {
  const daemon = fakeDaemon(async (call, park) => (call === 1 ? { requests: [REQUEST] } : park()));
  let finishRewind: (() => void) | null = null;
  const port: RewindConversationPort = {
    preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }),
    rewind: () => new Promise((resolve) => { finishRewind = () => resolve({ droppedMessages: 4, undoSnapshotId: 'undo-1' }); }),
  };
  const client = createConversationRewindHost({ verbs: daemon.verbs, port, hosts: () => true, log: quiet });
  client.offer('s1');
  const pumping = client.pump();
  await until(() => finishRewind !== null);
  client.offer('s2'); // the session switches while the rewind is running
  await turn();
  finishRewind!();
  await pumping;
  await client.stop();
  const methods = daemon.calls.map((c) => c.method);
  const answered = methods.indexOf('rewind.conversation.requests.answer');
  expect(answered).toBeGreaterThan(-1);
  expect(daemon.calls[answered]!.input).toMatchObject({ droppedMessages: 4, undoSnapshotId: 'undo-1' });
  expect(answered).toBeLessThan(methods.indexOf('rewind.conversation.host.release'));
});

test('a question the daemon already stopped waiting for is not applied', async () => {
  const daemon = fakeDaemon(async (call, park) => (call === 1 ? { requests: [{ ...REQUEST, expiresAt: 500 }] } : park()));
  let rewound = 0;
  const port: RewindConversationPort = {
    preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }),
    rewind: async () => { rewound += 1; return { droppedMessages: 1, undoSnapshotId: 'u' }; },
  };
  const client = createConversationRewindHost({ verbs: daemon.verbs, port, hosts: () => true, log: quiet, now: () => 1_000 });
  client.offer('s1');
  await client.pump();
  expect(rewound).toBe(0);
  expect(daemon.calls.some((c) => c.method === 'rewind.conversation.requests.answer')).toBe(false);
  await client.stop();
});

test('an intermediary that answers a take with nothing at once does not make the loop hot', async () => {
  // Parks after a safety bound so a regression fails the assertion instead of spinning forever.
  const daemon = fakeDaemon(async (call, park) => (call > 50 ? park() : { requests: [] }));
  const sleeps: number[] = [];
  const client = createConversationRewindHost({
    verbs: daemon.verbs, hosts: () => true, log: quiet, now: () => 0,
    port: { preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }), rewind: async () => ({ droppedMessages: 0, undoSnapshotId: 'u' }) },
    sleep: (ms) => { sleeps.push(ms); return parked(); },
  });
  client.start('s1');
  await until(() => sleeps.length > 0);
  await turn();
  expect(daemon.takes()).toBe(1);
  expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);
  await client.stop();
});

test('a session that keeps being taken over is claimed less and less often', async () => {
  const daemon = fakeDaemon(async (call, park) => { if (call > 4) return park(); throw new Error('hostId is not registered'); });
  const sleeps: number[] = [];
  const client = createConversationRewindHost({
    verbs: daemon.verbs, hosts: () => true, log: quiet, now: () => 0, retryBackoffMs: 1_000,
    port: { preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }), rewind: async () => ({ droppedMessages: 0, undoSnapshotId: 'u' }) },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  client.start('s1');
  await until(() => daemon.takes() >= 5);
  await client.stop();
  expect(sleeps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
});

test('a take refused because another surface took the session over ends the offer instead of claiming it back', async () => {
  const daemon = fakeDaemon(async () => { throw takenOver(); });
  const warnings: string[] = [];
  const client = createConversationRewindHost({
    verbs: daemon.verbs, hosts: () => true, log: { ...quiet, warn: (message: string) => { warnings.push(message); } },
    port: { preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }), rewind: async () => ({ droppedMessages: 0, undoSnapshotId: 'u' }) },
    sleep: async () => {},
  });
  client.start('s1');
  await until(() => warnings.length > 0);
  await turn();
  expect(daemon.calls.filter((c) => c.method === 'rewind.conversation.host.register')).toHaveLength(1);
  expect(daemon.takes()).toBe(1);
  await client.stop();
});

test('a surface that lost the session to another one offers it again once its person acts on it', async () => {
  const daemon = fakeDaemon(async (call, park) => {
    if (call === 1) throw takenOver();
    return park();
  });
  const warnings: string[] = [];
  const client = createConversationRewindHost({
    verbs: daemon.verbs, hosts: () => true, log: { ...quiet, warn: (message: string) => { warnings.push(message); } },
    port: { preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }), rewind: async () => ({ droppedMessages: 0, undoSnapshotId: 'u' }) },
    sleep: async () => {},
  });
  // Nothing taken over yet: acting on the session changes nothing.
  expect(client.resumeIfTakenOver()).toBe(false);
  client.start('s1');
  await until(() => warnings.length > 0);
  await turn();
  expect(daemon.takes()).toBe(1);
  expect(client.resumeIfTakenOver()).toBe(true);
  await until(() => daemon.takes() >= 2);
  expect(daemon.calls.filter((c) => c.method === 'rewind.conversation.host.register')).toHaveLength(2);
  // Already offering again: a second action does not start a second loop.
  expect(client.resumeIfTakenOver()).toBe(false);
  await client.stop();
});

test('a rewind answered by the host also drops the rewound anchors from the sidecar', async () => {
  const dir = makeProjectTempDir('gv-rewind-host-anchors');
  try {
    const surface = makeTestSurface(dir);
    recordTurnAnchor('s1', { turnId: 't1', label: 't1', messageCount: 2, at: 1 });
    recordTurnAnchor('s1', { turnId: 't2', label: 't2', messageCount: 4, at: 2 });
    const daemon = fakeDaemon(async (call, park) => (call === 1 ? { requests: [REQUEST] } : park()));
    const client = createConversationRewindHost({
      verbs: daemon.verbs, hosts: () => true, log: quiet, surface,
      port: { preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }), rewind: async () => ({ droppedMessages: 2, undoSnapshotId: 'u' }) },
    });
    client.offer('s1');
    await client.pump();
    await client.stop();
    expect(getTurnAnchors('s1').map((a) => a.turnId)).toEqual(['t1']);
    clearTurnAnchors('s1');
    expect(restoreTurnAnchors('s1', surface)).toBe(1);
  } finally {
    clearTurnAnchors('s1');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rewind applied here whose outcome the daemon refused is put back from its undo snapshot', async () => {
  const daemon = fakeDaemon(async (call, park) => (call === 1 ? { requests: [REQUEST] } : park()));
  const original = daemon.verbs.invoke;
  let answers = 0;
  daemon.verbs.invoke = async <T,>(method: string, input?: unknown): Promise<T> => {
    if (method !== 'rewind.conversation.requests.answer') return await original<T>(method, input);
    answers += 1;
    throw Object.assign(new Error('the request stopped waiting'), { status: 409, code: 'CONFLICT' });
  };
  const restored: string[] = [];
  const client = createConversationRewindHost({
    verbs: daemon.verbs, hosts: () => true, log: quiet,
    port: {
      preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0 }),
      rewind: async () => ({ droppedMessages: 3, undoSnapshotId: 'undo-9' }),
      messagesSinceRewind: () => 0,
      restoreBefore: (id) => { restored.push(id); return true; },
    },
  });
  client.offer('s1');
  await client.pump();
  await client.stop();
  // A definite refusal is not retried, and the cut does not outlive it.
  expect(answers).toBe(1);
  expect(restored).toEqual(['undo-9']);
});
