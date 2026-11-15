/**
 * A surface replaced by another one is told so, not that its host id is
 * unknown: only the first answer should end its offer; the second is a lapsed
 * lease or a daemon restart, which it answers by claiming again.
 */
import { describe, expect, test } from 'bun:test';
import { CONVERSATION_HOST_TAKEN_OVER_CODE, ConversationRewindHostBroker, ConversationRewindHostError } from '../platform/src/platform/rewind/conversation-host-broker.ts';

async function refusalOf(promise: Promise<unknown>): Promise<ConversationRewindHostError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ConversationRewindHostError);
  return error as ConversationRewindHostError;
}

describe('conversation host takeover', () => {
  test('the replaced surface is told another surface took over', async () => {
    const broker = new ConversationRewindHostBroker();
    const first = broker.registerHost({ sessionId: 's1' });
    broker.registerHost({ sessionId: 's1' });
    const refusal = await refusalOf(broker.takeRequests({ hostId: first.hostId }));
    expect(refusal.refusal).toBe('taken-over');
    expect(refusal.code).toBe(CONVERSATION_HOST_TAKEN_OVER_CODE);
  });

  test('a host id the broker never issued stays unknown, so the surface registers again', async () => {
    const broker = new ConversationRewindHostBroker();
    const refusal = await refusalOf(broker.takeRequests({ hostId: 'cvh_never-issued' }));
    expect(refusal.refusal).toBe('host-unknown');
    expect(refusal.code).not.toBe(CONVERSATION_HOST_TAKEN_OVER_CODE);
  });

  test('a lapsed lease is unknown, not a takeover', async () => {
    let clock = 0;
    const broker = new ConversationRewindHostBroker({ now: () => clock });
    const host = broker.registerHost({ sessionId: 's1', leaseMs: 5_000 });
    clock = 60_000;
    const refusal = await refusalOf(broker.takeRequests({ hostId: host.hostId }));
    expect(refusal.refusal).toBe('host-unknown');
  });
});
