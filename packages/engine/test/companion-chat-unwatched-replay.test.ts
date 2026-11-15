/**
 * A turn that runs before any event stream is open must reach the session's own
 * stream when it opens later, and nobody else's.
 */

import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionLLMProvider, CompanionProviderChunk } from '../platform/src/platform/companion/companion-chat-manager.js';
import { settleEvents } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { RuntimeEventBus } from './_helpers/runtime-seam.ts';

const disposables = trackDisposables();

const provider: CompanionLLMProvider = {
  async *chatStream() {
    yield { type: 'text_delta', delta: 'reply' } satisfies CompanionProviderChunk;
    yield { type: 'done' } satisfies CompanionProviderChunk;
  },
};

async function readUntil(response: Response, stop: (text: string) => boolean): Promise<string> {
  const reader = response.body!.getReader();
  let text = '';
  for (let i = 0; i < 12 && !stop(text); i += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}

describe('companion chat turn published before a stream exists', () => {
  test('replays to the session\'s own later stream and not to another session\'s', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    const manager = disposables.add(new CompanionChatManager({ provider, eventPublisher: gateway, gcIntervalMs: 999_999 }));
    const own = manager.createSession({ title: 'own' });
    const other = manager.createSession({ title: 'other' });

    await manager.postMessage(own.id, 'hello');
    await settleEvents();
    gateway.publishEvent('agents', { marker: true });

    const stream = (sessionId: string, abort: AbortController): Response => gateway.createEventStream(
      new Request('http://127.0.0.1/events', { signal: abort.signal }),
      { clientId: `companion-chat:${sessionId}:ab12cd34`, clientKind: 'web', sessionId, domains: ['agents'] },
    );

    const ownAbort = new AbortController();
    const ownText = await readUntil(stream(own.id, ownAbort), (t) => t.includes('"marker"'));
    ownAbort.abort();
    expect(ownText).toContain('companion-chat.turn.completed');

    const otherAbort = new AbortController();
    const otherText = await readUntil(stream(other.id, otherAbort), (t) => t.includes('"marker"'));
    otherAbort.abort();
    expect(otherText).toContain('"marker"');
    expect(otherText).not.toContain('companion-chat.turn');
  });
});
