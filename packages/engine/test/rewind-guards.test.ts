/**
 * What a rewind refuses to do half-way, and what it keeps consistent: one apply
 * per session at a time, no file restore when the conversation cannot follow, a
 * receipt that names the undo point even when the conversation half fails, and
 * turn anchors that never outlive the turns they name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
  UnifiedRewindService,
  type RewindAnchor,
  type RewindConversationPort,
  type RewindWorkspacePort,
} from '../platform/src/platform/rewind/index.ts';
import {
  CONVERSATION_PREVIEW_REDELIVER_MS,
  ConversationRewindHostBroker,
  ConversationRewindHostError,
} from '../platform/src/platform/rewind/conversation-host-broker.ts';
import {
  clearTurnAnchors,
  discardTurnAnchorsAfter,
  getTurnAnchors,
  persistTurnAnchors,
  recordTurnAnchor,
  restoreDiscardedTurnAnchors,
  restoreTurnAnchors,
  type TurnAnchor,
} from '../platform/src/platform/rewind/turn-anchors.ts';
import { makeTestSurface } from './_helpers/session-surface.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const anchor: RewindAnchor = { sessionId: 'guard-s1', turnId: 'turn-1' };

function workspace(restoreCalls: string[]): RewindWorkspacePort {
  return {
    list: async () => [{ id: 'wcp_a', turnId: 'turn-1', createdAt: 100, label: 'turn 1' }],
    diff: async () => ({ files: ['a.ts'] }),
    restore: async (id) => {
      restoreCalls.push(id);
      return { checkpointId: id, safetyCheckpointId: 'wcp_safety', restoredFiles: ['a.ts'], removedFiles: [] };
    },
  };
}

const okConversation: RewindConversationPort = {
  preview: async () => ({ messagesToDrop: 2, messagesRemaining: 4 }),
  rewind: async () => ({ droppedMessages: 2, undoSnapshotId: 'conv_undo' }),
};

describe('rewinding files and conversation together', () => {
  test('a conversation that cannot be rewound refuses the whole rewind before any file is touched', async () => {
    const restores: string[] = [];
    const service = new UnifiedRewindService({
      workspace: workspace(restores),
      conversation: { ...okConversation, preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0, available: false, unavailableReason: 'the host lapsed' }) },
    });
    const result = await service.apply(anchor, 'both', { confirm: true });
    expect(result.refused).toBe(true);
    expect(result.refusal?.reason).toContain('the host lapsed');
    expect(result.refusal?.reason).toContain('Nothing was changed');
    expect(restores).toEqual([]);
  });

  test('a conversation rewind that throws after the files were restored still returns the receipt with the undo point', async () => {
    const restores: string[] = [];
    const service = new UnifiedRewindService({
      workspace: workspace(restores),
      conversation: { ...okConversation, rewind: async () => { throw new Error('host connection dropped'); } },
    });
    const result = await service.apply(anchor, 'both', { confirm: true });
    expect(result.refused).toBe(false);
    expect(result.receipt?.undo.files).toEqual({ restoreCheckpointId: 'wcp_safety' });
    expect(result.receipt?.conversation?.rewound).toBe(false);
    expect(result.receipt?.warnings.join(' ')).toContain('host connection dropped');
    expect(restores).toEqual(['wcp_a']);
  });

  test('a conversation-only rewind that throws changed nothing, so the error is not swallowed', async () => {
    const service = new UnifiedRewindService({
      conversation: { ...okConversation, rewind: async () => { throw new Error('host connection dropped'); } },
    });
    await expect(service.apply({ sessionId: 'guard-s1' }, 'conversation', { confirm: true })).rejects.toThrow('host connection dropped');
  });
});

describe('two applies for one session', () => {
  test('the second is refused while the first runs, and only one restore happens', async () => {
    const restores: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const slow: RewindWorkspacePort = {
      ...workspace(restores),
      restore: async (id) => {
        restores.push(id);
        entered();
        await gate;
        return { checkpointId: id, safetyCheckpointId: 'wcp_safety', restoredFiles: [], removedFiles: [] };
      },
    };
    const service = new UnifiedRewindService({ workspace: slow });
    const first = service.apply(anchor, 'files', { confirm: true });
    await inside;
    const second = await service.apply(anchor, 'files', { confirm: true });
    expect(second.refused).toBe(true);
    expect(second.refusal?.reason).toContain('still running');
    release();
    expect((await first).refused).toBe(false);
    expect(restores).toEqual(['wcp_a']);
    // Once the first has finished, the session can be rewound again.
    expect((await service.apply(anchor, 'files', { confirm: true })).refused).toBe(false);
  });
});

describe('turn anchors after a rewind', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const id of ['anchors-a', 'anchors-b']) clearTurnAnchors(id);
  });
  const turn = (turnId: string, messageCount: number): TurnAnchor => ({ turnId, label: turnId, messageCount, at: messageCount });

  test('discarded anchors do not come back when the session is resumed before another turn', () => {
    const dir = makeProjectTempDir('gv-rewind-anchors');
    dirs.push(dir);
    const surface = makeTestSurface(dir);
    for (const [id, count] of [['t1', 2], ['t2', 4], ['t3', 6]] as const) recordTurnAnchor('anchors-a', turn(id, count));
    // The sidecar holds all three, as it does after the last completed turn.
    persistTurnAnchors('anchors-a', surface);
    const dropped = discardTurnAnchorsAfter('anchors-a', 't1', surface);
    expect(dropped.map((a) => a.turnId)).toEqual(['t2', 't3']);
    clearTurnAnchors('anchors-a');
    expect(restoreTurnAnchors('anchors-a', surface)).toBe(1);
    expect(getTurnAnchors('anchors-a').map((a) => a.turnId)).toEqual(['t1']);
  });

  test('undoing the rewind gives the discarded anchors back', () => {
    const dir = makeProjectTempDir('gv-rewind-anchors');
    dirs.push(dir);
    const surface = makeTestSurface(dir);
    for (const [id, count] of [['t1', 2], ['t2', 4]] as const) recordTurnAnchor('anchors-a', turn(id, count));
    const dropped = discardTurnAnchorsAfter('anchors-a', 't1', surface);
    restoreDiscardedTurnAnchors('anchors-a', dropped, surface);
    expect(getTurnAnchors('anchors-a').map((a) => a.turnId)).toEqual(['t1', 't2']);
  });

  test('a rewind through the service rewrites the sidecar', async () => {
    const dir = makeProjectTempDir('gv-rewind-anchors');
    dirs.push(dir);
    const surface = makeTestSurface(dir);
    for (const [id, count] of [['t1', 2], ['t2', 4]] as const) recordTurnAnchor('anchors-b', turn(id, count));
    const sessionAnchor: RewindAnchor = { sessionId: 'anchors-b', turnId: 't1' };
    const service = new UnifiedRewindService({ conversation: okConversation, anchorSurface: surface });
    await service.apply(sessionAnchor, 'conversation', { confirm: true });
    clearTurnAnchors('anchors-b');
    expect(restoreTurnAnchors('anchors-b', surface)).toBe(1);
  });

  test('undoing a rewind through the service gives its anchors back in the sidecar, and redoing drops them again', async () => {
    const dir = makeProjectTempDir('gv-rewind-anchors');
    dirs.push(dir);
    const surface = makeTestSurface(dir);
    for (const [id, count] of [['t1', 2], ['t2', 4]] as const) recordTurnAnchor('anchors-b', turn(id, count));
    persistTurnAnchors('anchors-b', surface);
    const service = new UnifiedRewindService({ conversation: okConversation, anchorSurface: surface });
    await service.apply({ sessionId: 'anchors-b', turnId: 't1' }, 'conversation', { confirm: true });
    service.anchorsRestored('conv_undo');
    clearTurnAnchors('anchors-b');
    expect(restoreTurnAnchors('anchors-b', surface)).toBe(2);
    service.anchorsDropped('conv_undo');
    clearTurnAnchors('anchors-b');
    expect(restoreTurnAnchors('anchors-b', surface)).toBe(1);
  });

  test('the registry lets go of the session recorded to least recently past its bound', () => {
    for (let i = 0; i < 257; i++) recordTurnAnchor(`bounded-${i}`, turn('t1', 2));
    try {
      expect(getTurnAnchors('bounded-0')).toHaveLength(0);
      expect(getTurnAnchors('bounded-256')).toHaveLength(1);
    } finally {
      for (let i = 0; i < 257; i++) clearTurnAnchors(`bounded-${i}`);
    }
  });
});

describe('the conversation host broker', () => {
  function broker(clock: { now: number }): ConversationRewindHostBroker {
    return new ConversationRewindHostBroker({ now: () => clock.now, answerTimeoutMs: 600_000 });
  }

  test('a session hosted under one principal cannot be claimed by another', () => {
    const clock = { now: 0 };
    const b = broker(clock);
    b.registerHost({ sessionId: 's1', principalId: 'alice' });
    expect(() => b.registerHost({ sessionId: 's1', principalId: 'mallory' })).toThrow(ConversationRewindHostError);
    expect(() => b.registerHost({ sessionId: 's1' })).toThrow(ConversationRewindHostError);
    expect(() => b.registerHost({ sessionId: 's1', principalId: 'alice' })).not.toThrow();
    b.shutdown();
  });

  test('polling keeps the lease length the host asked for', () => {
    const clock = { now: 0 };
    const b = broker(clock);
    const host = b.registerHost({ sessionId: 's1', leaseMs: 5 * 60_000 });
    clock.now = 10_000;
    void b.takeRequests({ hostId: host.hostId });
    clock.now = 200_000;
    expect(b.listHosts().map((h) => h.hostId)).toEqual([host.hostId]);
    b.shutdown();
  });

  test('a preview the host did not answer is handed out again, a rewind is not', async () => {
    const clock = { now: 0 };
    const b = broker(clock);
    const host = b.registerHost({ sessionId: 's1' });
    const preview = b.preview({ sessionId: 's1' });
    const first = await b.takeRequests({ hostId: host.hostId });
    expect(first.requests).toHaveLength(1);
    expect((await b.takeRequests({ hostId: host.hostId })).requests).toHaveLength(0);
    clock.now = CONVERSATION_PREVIEW_REDELIVER_MS;
    const again = await b.takeRequests({ hostId: host.hostId });
    expect(again.requests.map((r) => r.requestId)).toEqual([first.requests[0]!.requestId]);
    b.answerRequest({ hostId: host.hostId, requestId: first.requests[0]!.requestId, answer: { kind: 'preview', messagesToDrop: 1, messagesRemaining: 2 } });
    expect(await preview).toEqual({ messagesToDrop: 1, messagesRemaining: 2 });

    const rewind = b.rewind({ sessionId: 's1' });
    const taken = await b.takeRequests({ hostId: host.hostId });
    expect(taken.requests[0]?.kind).toBe('rewind');
    clock.now += 10 * CONVERSATION_PREVIEW_REDELIVER_MS;
    expect((await b.takeRequests({ hostId: host.hostId })).requests).toHaveLength(0);
    b.shutdown();
    expect((await rewind).available).toBe(false);
  });

  test('a host holding a poll open is handed a lost preview when it becomes due, not when the poll ends', async () => {
    const clock = { now: 0 };
    const b = broker(clock);
    const host = b.registerHost({ sessionId: 's1' });
    void b.preview({ sessionId: 's1' });
    const first = await b.takeRequests({ hostId: host.hostId });
    expect(first.requests).toHaveLength(1);

    // Capture the timers the held poll schedules so the test fires them itself instead of sleeping.
    const realSetTimeout = globalThis.setTimeout;
    const scheduled: { fn: () => void; ms: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      scheduled.push({ fn, ms: ms ?? 0 });
      return realSetTimeout(() => {}, 0);
    }) as unknown as typeof setTimeout;
    let poll: ReturnType<typeof b.takeRequests>;
    try {
      poll = b.takeRequests({ hostId: host.hostId, waitMs: 20_000 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    const wait = scheduled.reduce((soonest, timer) => (timer.ms < soonest.ms ? timer : soonest));
    expect(wait.ms).toBeLessThanOrEqual(CONVERSATION_PREVIEW_REDELIVER_MS);
    clock.now = CONVERSATION_PREVIEW_REDELIVER_MS;
    wait.fn();
    const again = await poll;
    expect(again.requests.map((r) => r.requestId)).toEqual([first.requests[0]!.requestId]);
    b.shutdown();
  });

  test('an answer to a request past its deadline is refused as expired', async () => {
    const clock = { now: 0 };
    const b = new ConversationRewindHostBroker({ now: () => clock.now, answerTimeoutMs: 1_000 });
    const host = b.registerHost({ sessionId: 's1' });
    void b.preview({ sessionId: 's1' });
    const { requests } = await b.takeRequests({ hostId: host.hostId });
    clock.now = 2_000;
    let refusal: string | undefined;
    try {
      b.answerRequest({ hostId: host.hostId, requestId: requests[0]!.requestId, answer: { kind: 'preview', messagesToDrop: 1, messagesRemaining: 1 } });
    } catch (error) {
      refusal = error instanceof ConversationRewindHostError ? error.refusal : String(error);
    }
    expect(refusal).toBe('request-expired');
    b.shutdown();
  });
});
