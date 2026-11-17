/**
 * One inbound message runs once. The same ntfy or chat message can reach the
 * daemon by two routes (a subscription and a webhook, or a provider's
 * redelivery); the shared claim lets the first through and stops the second,
 * without ever swallowing a different message or one that has no id.
 */
import { describe, expect, test } from 'bun:test';
import { InboundMessageDedup, inboundDedupKey, runOncePerMessage } from '../platform/src/platform/adapters/inbound-dedup.ts';

describe('InboundMessageDedup', () => {
  test('a second delivery of the same message is not claimed', () => {
    const dedup = new InboundMessageDedup();
    const key = inboundDedupKey('ntfy', 'goodvibes-agent', 'msg-1');
    expect(dedup.claim(key)).toBe(true);
    expect(dedup.claim(key)).toBe(false);
  });

  test('a different message, or the same id on another topic, is claimed', () => {
    const dedup = new InboundMessageDedup();
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic-a', 'x'))).toBe(true);
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic-a', 'y'))).toBe(true);
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic-b', 'x'))).toBe(true);
  });

  test('messages with no id are each processed rather than collapsed onto one key', () => {
    const dedup = new InboundMessageDedup();
    const first = inboundDedupKey('ntfy', 'topic', undefined);
    const second = inboundDedupKey('ntfy', 'topic', '   ');
    expect(dedup.claim(first)).toBe(true);
    expect(dedup.claim(second)).toBe(true);
    expect(dedup.claim(first)).toBe(true);
  });
});

describe('runOncePerMessage', () => {
  const duplicate = () => new Response('duplicate', { status: 200 });

  test('work that succeeded keeps the claim, so a redelivery does nothing', async () => {
    const dedup = new InboundMessageDedup();
    let runs = 0;
    const work = async () => { runs += 1; return new Response('ok', { status: 200 }); };
    await runOncePerMessage('k', duplicate, work, dedup);
    expect(await (await runOncePerMessage('k', duplicate, work, dedup)).text()).toBe('duplicate');
    expect(runs).toBe(1);
  });

  test('work that failed gives the claim back, so the redelivery is processed', async () => {
    const dedup = new InboundMessageDedup();
    let runs = 0;
    await runOncePerMessage('k', duplicate, async () => { runs += 1; return new Response('busy', { status: 503 }); }, dedup);
    await expect(runOncePerMessage('k', duplicate, async () => { runs += 1; throw new Error('crashed'); }, dedup)).rejects.toThrow('crashed');
    const third = await runOncePerMessage('k', duplicate, async () => { runs += 1; return new Response('ok', { status: 200 }); }, dedup);
    expect(await third.text()).toBe('ok');
    expect(runs).toBe(3);
  });
});
