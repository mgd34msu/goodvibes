import { describe, expect, test } from 'bun:test';
import {
  NativeInboundReceiverRefusal,
  createNativeInboundHandoff,
} from '../platform/src/platform/control-plane/native-inbound-handoff.ts';
import type {
  NativeInboundResolvedSource,
  NativeInboundSourceRef,
  NativeInboundSourceResolver,
} from '../platform/src/platform/control-plane/native-inbound-source.ts';
import type { SharedSessionContinuationRequest } from '../platform/src/platform/control-plane/session-intents.ts';

const ref: NativeInboundSourceRef = { sessionId: 's1', inputId: 'i1', sourceId: 'src', sourceRevision: 'captured-original', requestId: 'inbound-src' };
const source = {
  ref,
  origin: { kind: 'external-original', accountId: 'a', accountRevision: 'a1', routeId: 'r', routeRevision: 'r1' },
  original: { text: 'hello', unsupportedSources: [] },
} as NativeInboundResolvedSource;
const request = { sessionId: 's1', input: { id: 'i1', sessionId: 's1', intent: 'submit' }, task: '' } as unknown as SharedSessionContinuationRequest;

function harness(accept: () => Promise<{ ref: NativeInboundSourceRef; disposition: 'transferred' }>) {
  const lifetime = new AbortController();
  const calls = { accept: 0 };
  const sources: NativeInboundSourceResolver = {
    reference: () => ref,
    assertQueued: () => undefined,
    withSource: (_ref, use) => use(source, () => undefined, new AbortController().signal),
  };
  const handoff = createNativeInboundHandoff({
    sources,
    lifetime: lifetime.signal,
    owner: { withCurrent: (_source, use) => use(() => undefined, 'owner-rev', new AbortController().signal) },
    receiver: {
      accept: () => { calls.accept += 1; return accept(); },
      inspect: async () => null,
      cancel: async () => undefined,
    },
  });
  return { handoff, calls };
}

describe('native inbound handoff after a receiver fault', () => {
  test('a refusal before any effect leaves the input held and a later run reaches the receiver again', async () => {
    let refuse = true;
    const { handoff, calls } = harness(async () => {
      if (refuse) throw new NativeInboundReceiverRefusal('No exact grant');
      return { ref, disposition: 'transferred' };
    });
    expect((await handoff.run(request)).disposition).toBe('held');
    refuse = false;
    expect((await handoff.run(request)).disposition).toBe('transferred');
    expect(calls.accept).toBe(2);
  });

  test('any other fault after accept was called stays unknown and is never replayed', async () => {
    const { handoff, calls } = harness(async () => { throw new Error('connection reset'); });
    expect((await handoff.run(request)).disposition).toBe('unknown');
    expect((await handoff.run(request)).disposition).not.toBe('transferred');
    expect(calls.accept).toBe(1);
  });
});
