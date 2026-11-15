import { describe, expect, test } from 'bun:test';
import {
  createApprovalCardQueue,
  sweepBrokerApprovals,
  type BrokerApprovalCardBroker,
} from '../../permissions/broker-approval-card.ts';
import type { PendingPermissionState } from '../../shell/blocking-input.ts';

type Card = { readonly callId: string; readonly answer: (approved: boolean) => void };

describe('one approval card at a time', () => {
  test('two overlapping local asks both get a card and both resolve', async () => {
    let pending: { callId: string; answer: (approved: boolean) => void } | null = null;
    const queue = createApprovalCardQueue<Card>({
      getPending: () => pending,
      callIdOf: (card) => card.callId,
      show: (card) => { pending = card; return true; },
    });
    const ask = (callId: string) => new Promise<boolean>((resolve) => queue.offer({ callId, answer: resolve }));
    const first = ask('call-1');
    const second = ask('call-2');
    expect(pending!.callId).toBe('call-1');

    pending!.answer(true); pending = null; queue.next();
    expect(pending!.callId).toBe('call-2');
    pending!.answer(false); pending = null; queue.next();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(queue.size()).toBe(0);
  });

  test('the same ask arriving again replaces its own card instead of queueing behind it', () => {
    let pending: Card | null = null;
    const queue = createApprovalCardQueue<Card>({ getPending: () => pending, callIdOf: (card) => card.callId, show: (card) => { pending = card; return true; } });
    queue.offer({ callId: 'call-1', answer: () => {} });
    const local = { callId: 'call-1', answer: () => {} };
    queue.offer(local);
    expect(pending as unknown).toBe(local);
    expect(queue.size()).toBe(0);
  });

  test('a queued ask settled elsewhere while waiting is skipped for the next one', () => {
    let pending: Card | null = null;
    const queue = createApprovalCardQueue<Card>({
      getPending: () => pending,
      callIdOf: (card) => card.callId,
      show: (card) => { if (card.callId === 'call-2') return false; pending = card; return true; },
    });
    queue.offer({ callId: 'call-1', answer: () => {} });
    queue.offer({ callId: 'call-2', answer: () => {} });
    queue.offer({ callId: 'call-3', answer: () => {} });
    pending = null; queue.next();
    expect(pending!.callId).toBe('call-3');
  });
});

describe('broker asks skipped while a card was up', () => {
  test('a later sweep offers the waiting broker ask once the slot is free', () => {
    const request = { callId: 'call-9', tool: 'ci-fix', args: {} } as never;
    const broker = {
      listApprovals: () => [],
      getApproval: () => ({ status: 'pending', request }),
      resolveApproval: async () => null,
    } as unknown as BrokerApprovalCardBroker;
    let pending: PendingPermissionState | null = null;
    const params = {
      broker,
      render: () => {},
      getPending: () => pending,
      setPending: (next: PendingPermissionState | null) => { pending = next; },
      defer: (callback: () => void) => callback(),
      listApprovals: () => [{ id: 'ap-9', callId: 'call-9', status: 'pending', request }],
    };
    sweepBrokerApprovals(params);
    expect(pending!.callId).toBe('call-9');
  });
});
