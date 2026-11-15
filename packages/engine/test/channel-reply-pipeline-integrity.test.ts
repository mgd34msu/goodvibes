import { describe, expect, test } from 'bun:test';
import { ChannelReplyPipeline } from '../platform/src/platform/channels/reply-pipeline.js';
import { buildRenderedText, normalizeChannelRenderEventFromRuntime, splitIntoChunks } from '../platform/src/platform/channels/reply-render.js';
import { selectUndeliveredEvents } from '../platform/src/platform/channels/reply-delta.js';
import { DEFAULT_POLICY } from '../platform/src/platform/channels/reply-policy.js';
import { renderBuiltinPolicy } from '../platform/src/platform/channels/builtin/presentation.js';
import type { ChannelSurface } from '../platform/src/platform/channels/types.js';

type Envelope = Parameters<typeof normalizeChannelRenderEventFromRuntime>[0];

function envelope(payload: Record<string, unknown>, traceId: string | undefined = 'trace-1'): Envelope {
  return { type: payload.type, ts: 1_000, traceId, sessionId: 's', source: 'test', payload } as unknown as Envelope;
}

function harness(options: { renderPolicy?: () => Promise<never>; hold?: () => Promise<void> } = {}) {
  const published: Array<{ phase: string; text: string }> = [];
  const pipeline = new ChannelReplyPipeline({
    channelPlugins: {
      getRenderPolicy: options.renderPolicy ?? (async () => null),
      render: async (_surface: string, request: { phase: string; text: string }) => {
        if (options.hold) await options.hold();
        published.push({ phase: request.phase, text: request.text });
        return { delivered: true, metadata: {} };
      },
    },
    routeBindings: { captureReplyTarget: async () => {} },
    now: () => 10_000_000,
    statusReadingTimeoutMs: 1,
    prepareStatusContent: () => new Promise<void>(() => {}),
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);
  const track = (agentId: string, extra: Record<string, unknown> = {}, surfaceKind = 'telegram') => pipeline.trackPending({
    agentId, surfaceKind, task: 'status', createdAt: 0, routeId: 'r', ...extra,
  } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
  return { pipeline, published, track };
}

describe('render event identity', () => {
  test('two events of one kind on one trace in the same millisecond both stay undelivered', () => {
    const events = [
      ...normalizeChannelRenderEventFromRuntime(envelope({ type: 'AGENT_PROGRESS', agentId: 'a', progress: 'first', audience: 'owner' })),
      ...normalizeChannelRenderEventFromRuntime(envelope({ type: 'AGENT_PROGRESS', agentId: 'a', progress: 'second', audience: 'owner' })),
    ];
    const watermark = { deliveredEventIds: new Set([events[0]!.id]) };
    expect(selectUndeliveredEvents(watermark, events).map((event) => event.text)).toEqual(['second']);
  });

  test('events without a trace id do not collide across agents', () => {
    const [a] = normalizeChannelRenderEventFromRuntime(envelope({ type: 'AGENT_PROGRESS', agentId: 'a', progress: 'x', audience: 'owner' }, undefined));
    const [b] = normalizeChannelRenderEventFromRuntime(envelope({ type: 'AGENT_PROGRESS', agentId: 'b', progress: 'x', audience: 'owner' }, undefined));
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('compaction diagnostics', () => {
  test('a failed or skipped compaction never reaches the owner text', () => {
    const failed = normalizeChannelRenderEventFromRuntime(envelope({ type: 'COMPACTION_FAILED' }));
    const skipped = normalizeChannelRenderEventFromRuntime(envelope({ type: 'COMPACTION_RECEIPT', outcome: 'skipped', tokensBefore: 10, tokensAfter: 10, qualityGrade: 'B' }));
    expect(buildRenderedText('', [...failed, ...skipped], DEFAULT_POLICY.telegram, 'progress')).toBe('');
  });
});

describe('final delivery', () => {
  test('an answer longer than the surface limit arrives in full across ordered messages', async () => {
    const { pipeline, published, track } = harness();
    track('a1');
    const words = Array.from({ length: 1500 }, (_, i) => `word${i}`);
    await pipeline.deliverFinal('a1', words.join(' '));
    expect(published.length).toBeGreaterThan(1);
    for (const message of published) expect(message.text.length).toBeLessThanOrEqual(DEFAULT_POLICY.telegram.maxChunkChars);
    expect(published.map((message) => message.text).join(' ').split(/\s+/)).toEqual(words);
  });

  test('chunks break at paragraph boundaries and lose no characters', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(60)}`;
    expect(splitIntoChunks(text, 100)).toEqual(['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]);
    expect(splitIntoChunks('x'.repeat(250), 100).join('')).toBe('x'.repeat(250));
  });

  test('a plugin render policy that throws still delivers and untracks the final', async () => {
    const { pipeline, published, track } = harness({ renderPolicy: async () => { throw new Error('plugin bug'); } });
    track('a1');
    await pipeline.deliverFinal('a1', 'the answer');
    expect(published.map((message) => message.text)).toEqual(['the answer']);
    expect(pipeline.has('a1')).toBe(false);
  });

  test('a status reading that never settles does not hold the final reply', async () => {
    const { pipeline, published, track } = harness();
    track('a1');
    await pipeline.deliverFinal('a1', 'done');
    expect(published.map((message) => message.text)).toEqual(['done']);
  });
});

describe('contract association', () => {
  test('associating a contract during a dispatch keeps its identical-body mark', async () => {
    const release = Promise.withResolvers<void>();
    const { pipeline, published, track } = harness({ hold: () => release.promise });
    track('a1');
    const first = pipeline.deliverProgress('a1', 'Reading the parser', false, 'owner');
    await Promise.resolve();
    (pipeline as unknown as { associateContract(agentId: string, contractId: string): void }).associateContract('a1', 'c1');
    release.resolve();
    await first;
    expect(await pipeline.deliverProgress('a1', 'Reading the parser', true, 'owner')).toBeNull();
    expect(published).toHaveLength(1);
    expect(pipeline.getPending('a1')?.contractId).toBe('c1');
  });

  test('an ask shared by pending replies in different conversations is attached to none of them', () => {
    const { pipeline, track } = harness();
    track('a1', { sessionId: 's1' });
    track('a2', { sessionId: 's2' });
    const find = (pipeline as unknown as { findPendingForAsk(ask: string, owner: string, session?: string): unknown }).findPendingForAsk.bind(pipeline);
    expect(find('status', 'nobody')).toBeNull();
    expect((find('status', 'nobody', 's2') as { pending: { agentId: string } }).pending.agentId).toBe('a2');
  });
});

describe('built-in surface policy', () => {
  test('every surface splits at the same size as the default reply policy', () => {
    for (const surface of Object.keys(DEFAULT_POLICY) as ChannelSurface[]) {
      const builtin = renderBuiltinPolicy(surface);
      expect(builtin.maxChunkChars).toBe(DEFAULT_POLICY[surface].maxChunkChars);
      expect(builtin.metadata).toMatchObject({ builtIn: true });
    }
    expect(DEFAULT_POLICY.telephony.metadata).toEqual({});
  });
});
