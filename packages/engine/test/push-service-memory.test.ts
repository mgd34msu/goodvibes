import { describe, expect, test } from 'bun:test';
import { MAX_REMEMBERED_PUSH_IDS, PushService } from '../platform/src/platform/push/service.ts';
import type { FleetNotice, FleetNoticeSource } from '../platform/src/platform/push/service.ts';
import type { PushMessage, PushSubscriptionStore, VapidManager } from '../platform/src/platform/push/index.ts';

function makeService(scheduled: Array<() => void> = []): { service: PushService; delivered: PushMessage[] } {
  const service = new PushService({
    vapid: {} as VapidManager,
    store: {} as PushSubscriptionStore,
    scheduler: { schedule: (fn) => { scheduled.push(fn); return () => {}; } },
  });
  const delivered: PushMessage[] = [];
  (service as unknown as { deliver: (m: PushMessage) => Promise<unknown[]> }).deliver = async (m) => { delivered.push(m); return []; };
  return { service, delivered };
}

function completionSource(): { source: FleetNoticeSource; push: (n: FleetNotice) => void } {
  let listener: ((n: FleetNotice) => void) | null = null;
  return { source: { subscribe: (l) => { listener = l; return () => { listener = null; }; } }, push: (n) => listener?.(n) };
}

const finished = (nodeId: string): FleetNotice => ({ type: 'FLEET_NODE_FINISHED', nodeId, kind: 'agent', state: 'done' });

describe('push de-duplication memory', () => {
  test('remembers a bounded number of finished runs, forgetting the oldest first', () => {
    const { service, delivered } = makeService();
    const { source, push } = completionSource();
    service.attachCompletionSource(source);
    for (let i = 0; i <= MAX_REMEMBERED_PUSH_IDS; i++) push(finished(`n${i}`));
    expect(delivered).toHaveLength(MAX_REMEMBERED_PUSH_IDS + 1);
    // The newest is still remembered: a re-publish does not push again.
    push(finished(`n${MAX_REMEMBERED_PUSH_IDS}`));
    expect(delivered).toHaveLength(MAX_REMEMBERED_PUSH_IDS + 1);
    // The oldest fell out of the set, so it is the one that may push again.
    push(finished('n0'));
    expect(delivered).toHaveLength(MAX_REMEMBERED_PUSH_IDS + 2);
  });
});

describe('needs-input escalation after a restart', () => {
  test('an ask already waiting when the source is attached still escalates, with no fresh immediate push', () => {
    const scheduled: Array<() => void> = [];
    const { service, delivered } = makeService(scheduled);
    const waiting: FleetNotice = { type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'n1', label: 'Deploy', reason: 'approval', sessionId: 's1' };
    const { source } = completionSource();
    service.attachFleetNeedsInputSource({ ...source, currentlyBlocked: () => [waiting] });
    expect(delivered).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ title: 'Still waiting on you', data: { kind: 'needs-input', nodeId: 'n1', escalated: true } });
    service.dispose();
  });
});
