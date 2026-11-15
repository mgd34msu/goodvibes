/**
 * Every pending surface reply has an exit: an agent this daemon cannot see is
 * given up on after a bound, a failed session write does not hold the answer
 * back, overlapping polls do not finish the same agent twice, and a stop
 * records what it dropped.
 */
import { expect, test } from 'bun:test';
import { DaemonSurfaceDeliveryHelper, ORPHANED_SURFACE_REPLY_MAX_AGE_MS, type SurfaceDeliveryLedgerEntry } from '../platform/src/platform/daemon/surface-delivery.ts';
import type { PendingSurfaceReply } from '../platform/src/platform/daemon/types.ts';

function fixture(options: {
  readonly record?: () => unknown;
  readonly completeAgent?: () => Promise<unknown>;
  readonly deliverFinal?: () => Promise<void>;
} = {}) {
  const ledger: SurfaceDeliveryLedgerEntry[] = [];
  const pending = new Map<string, PendingSurfaceReply>();
  const untracked: string[] = [], delivered: string[] = [];
  let completions = 0;
  let clock = 1_000_000;
  const helper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: pending,
    channelReplyPipeline: {
      has: () => true,
      untrack: (agentId: string) => void untracked.push(agentId),
      deliverFinal: async (agentId: string) => { await options.deliverFinal?.(); delivered.push(agentId); },
      deliverProgress: async () => {},
    },
    agentManager: { getStatus: () => options.record?.() },
    sessionBroker: { completeAgent: async () => { completions++; return options.completeAgent?.(); } },
    routeBindings: { getBinding: () => undefined },
    recordDeliveryAttempt: (entry: SurfaceDeliveryLedgerEntry) => void ledger.push(entry),
  } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0], () => clock);
  const queue = (agentId: string) => pending.set(agentId, { agentId, surfaceKind: 'telegram', task: 'task', createdAt: clock, sessionId: 'session-1', routeId: 'route-1' });
  return { helper, ledger, pending, untracked, delivered, queue, completions: () => completions, advance: (ms: number) => { clock += ms; } };
}

const finished = { id: 'agent-1', status: 'completed', task: 'task', fullOutput: 'the answer', tools: [], startedAt: 1 };

test('a reply whose agent this daemon never sees is recorded failed and dropped after the bound', async () => {
  const f = fixture();
  f.queue('agent-1');
  await f.helper.pollPendingSurfaceReplies(() => {});
  expect(f.pending.size).toBe(1);
  f.advance(ORPHANED_SURFACE_REPLY_MAX_AGE_MS + 1);
  await f.helper.pollPendingSurfaceReplies(() => {});
  expect(f.pending.size).toBe(0);
  expect(f.untracked).toEqual(['agent-1']);
  expect(f.ledger.map(entry => entry.phase)).toEqual(['failed']);
  expect(f.ledger[0]?.error).toContain('never reported back');
});

test('a failed session write still delivers the answer and releases the entry', async () => {
  const f = fixture({ record: () => finished, completeAgent: () => Promise.reject(new Error('fixture: session store unavailable')) });
  f.queue('agent-1');
  await f.helper.pollPendingSurfaceReplies(() => {});
  expect(f.delivered).toEqual(['agent-1']);
  expect(f.pending.size).toBe(0);
  expect(f.ledger.map(entry => entry.phase)).toEqual(['started']);
});

test('an overlapping poll does not finish the same agent a second time', async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture({ record: () => finished, deliverFinal: () => gate.promise });
  f.queue('agent-1');
  const first = f.helper.pollPendingSurfaceReplies(() => {});
  await Promise.resolve();
  await f.helper.pollPendingSurfaceReplies(() => {});
  gate.resolve();
  await first;
  expect(f.completions()).toBe(1);
  expect(f.delivered).toEqual(['agent-1']);
});

test('dropping pending replies at stop records each one as failed', () => {
  const f = fixture();
  f.queue('agent-1');
  f.queue('agent-2');
  f.helper.abandonPendingSurfaceReplies('the daemon stopped before the reply was delivered');
  expect(f.pending.size).toBe(0);
  expect(f.ledger.map(entry => [entry.agentId, entry.phase, entry.error])).toEqual([
    ['agent-1', 'failed', 'the daemon stopped before the reply was delivered'],
    ['agent-2', 'failed', 'the daemon stopped before the reply was delivered'],
  ]);
});
