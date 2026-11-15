/** A final reply the channel refuses with an error is retried per message part before it is reported undelivered. */
import { describe, expect, test } from 'bun:test';
import { ChannelReplyPipeline } from '../platform/src/platform/channels/reply-pipeline.js';

function harness(failures: number, captureFails = false) {
  const published: string[] = [];
  const waits: number[] = [];
  const undelivered: Array<{ body: string; reason: string }> = [];
  let calls = 0;
  const pipeline = new ChannelReplyPipeline({
    channelPlugins: {
      getRenderPolicy: async () => null,
      render: async (_surface: string, request: { text: string }) => {
        calls++;
        if (calls <= failures) throw new Error('429 too many requests');
        published.push(request.text);
        return { delivered: true, responseId: 'msg-1', metadata: {} };
      },
    },
    routeBindings: { captureReplyTarget: async () => { if (captureFails) throw new Error('route binding is gone'); } },
    now: () => 10_000_000,
    statusReadingTimeoutMs: 1,
    prepareStatusContent: () => new Promise<void>(() => {}),
    waitBeforeRetry: async (ms: number) => { waits.push(ms); },
    onUndelivered: (reply: { body: string; reason: string }) => undelivered.push(reply),
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);
  pipeline.trackPending({ agentId: 'a1', surfaceKind: 'telegram', task: 'status', createdAt: 0, routeId: 'r' });
  return { pipeline, published, waits, undelivered };
}

describe('final reply retry', () => {
  test('a transient channel error is retried with backoff and the answer arrives once', async () => {
    const { pipeline, published, waits, undelivered } = harness(2);
    const result = await pipeline.deliverFinal('a1', 'the answer');
    expect(result?.delivered).toBe(true);
    expect(waits).toEqual([1_000, 4_000]);
    expect(published).toEqual(['the answer']);
    expect(undelivered).toEqual([]);
  });

  test('after three failed attempts the reply is reported undelivered with its body', async () => {
    const { pipeline, published, waits, undelivered } = harness(10);
    const result = await pipeline.deliverFinal('a1', 'the answer');
    expect(result).toBeNull();
    expect(waits).toEqual([1_000, 4_000]);
    expect(published).toEqual([]);
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]).toMatchObject({ body: 'the answer', reason: '429 too many requests' });
  });

  test('a failure to record the reply target after the channel accepted the message is not resent', async () => {
    const { pipeline, published, waits, undelivered } = harness(0, true);
    const result = await pipeline.deliverFinal('a1', 'the answer');
    expect(result?.delivered).toBe(true);
    expect(published).toEqual(['the answer']);
    expect(waits).toEqual([]);
    expect(undelivered).toEqual([]);
  });
});
