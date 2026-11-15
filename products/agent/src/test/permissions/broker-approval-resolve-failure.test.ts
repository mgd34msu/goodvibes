import { describe, expect, test } from 'bun:test';
import { handleBrokerApprovalChange, type BrokerApprovalBroker } from '../../permissions/broker-approval.ts';
import type { PendingPermissionState } from '../../shell/blocking-input.ts';

const request = { callId: 'call-1', tool: 'exec', args: {}, category: 'execute' } as never;

function open(broker: BrokerApprovalBroker) {
  let pending: PendingPermissionState | null = null;
  let renders = 0;
  const failures: unknown[] = [];
  handleBrokerApprovalChange({
    approval: { id: 'ap-1', callId: 'call-1', status: 'pending', request },
    getPending: () => pending,
    setPending: (next) => { pending = next; },
    broker,
    render: () => { renders += 1; },
    defer: (callback) => callback(),
    onResolveFailed: (error) => { failures.push(error); },
  });
  return { card: () => pending, clear: () => { pending = null; }, renders: () => renders, failures };
}

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('a broker ask whose answer could not be recorded', () => {
  test('the card comes back while the ask is still open, and the failure is reported', async () => {
    const broker = {
      getApproval: () => ({ status: 'pending', request }),
      resolveApproval: async () => { throw new Error('store unavailable'); },
    } as unknown as BrokerApprovalBroker;
    const view = open(broker);
    const card = view.card()!;
    // The key press clears the card, then answers.
    view.clear();
    card.resolve(true, false);
    await tick();
    expect(view.card()).toBe(card);
    expect(view.failures).toHaveLength(1);
  });

  test('an ask that is already resolved elsewhere does not bring the card back', async () => {
    let status = 'pending';
    const broker = {
      getApproval: () => ({ status, request }),
      resolveApproval: async () => { status = 'approved'; throw new Error('already resolved'); },
    } as unknown as BrokerApprovalBroker;
    const view = open(broker);
    const card = view.card()!;
    view.clear();
    card.resolve(true, false);
    await tick();
    expect(view.card()).toBeNull();
  });
});
