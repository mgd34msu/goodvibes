/**
 * useCompactionReceipts, one session's compaction frames on the shared stream's detail lane.
 *
 * Mocks platform.streams.open, captures the registered handlers and drives them by hand.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

let capturedHandlers: ServerSentEventHandlers | null = null;
const openCalls: string[] = [];
const closers: Array<ReturnType<typeof mock>> = [];
const cleanups: Array<() => void> = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  client: {
    streams: {
      open: (pathOrUrl: string, handlers: ServerSentEventHandlers) => {
        openCalls.push(pathOrUrl);
        capturedHandlers = handlers;
        const close = mock(() => {});
        closers.push(close);
        return Promise.resolve(close);
      },
    },
  },
}));

const { useCompactionReceipts } = await import('./useCompactionReceipts');

let latestState: ReturnType<typeof useCompactionReceipts> | null = null;

function renderHook(sessionId: string, enabled = true): { rerender: (sessionId: string, enabled: boolean) => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness({ id, on }: { id: string; on: boolean }) {
    latestState = useCompactionReceipts(id, on);
    return null;
  }

  const doRender = (id: string, on: boolean) => {
    flushSync(() => {
      root.render(React.createElement(Harness, { id, on }));
    });
  };
  doRender(sessionId, enabled);

  // Registered for afterEach so a failed assertion cannot leave the root mounted.
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    if (container.parentNode) container.parentNode.removeChild(container);
  };
  cleanups.push(unmount);

  return { rerender: doRender, unmount };
}

/** The stream owner opens on the next microtask and stores the closer one microtask later. */
async function settleOpen(): Promise<void> {
  for (let index = 0; index < 4; index++) await Promise.resolve();
}

/** Fire a frame and flush the resulting setState synchronously so latestState
 *  reflects it before the assertion, onEvent() is called directly from test
 *  code, outside React's own event system, so automatic batching would
 *  otherwise defer the re-render past this function's return. */
function fireEvent(eventName: string, payload: unknown): void {
  flushSync(() => {
    capturedHandlers?.onEvent?.(eventName, payload);
  });
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  closers.length = 0;
  capturedHandlers = null;
  openCalls.length = 0;
  latestState = null;
});

describe('useCompactionReceipts', () => {
  test('a transport error body (raw 401 JSON) never reaches the returned error', async () => {
    renderHook('s-1');
    await settleOpen();
    flushSync(() => capturedHandlers?.onError?.(new Error('{"error":"Authentication required","code":"AUTH_REQUIRED","status":401}')));
    expect(latestState?.error).not.toBeNull();
    expect(latestState?.error).not.toContain('AUTH_REQUIRED');
    expect(latestState?.error).not.toContain('{');
  });

  test('opens the raw control-plane stream scoped to the compaction domain', async () => {
    renderHook('s-1');
    await settleOpen();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toContain('/api/control-plane/events');
    expect(openCalls[0]).toContain('domains=compaction');
  });

  test('does not open a stream when disabled', async () => {
    renderHook('s-1', false);
    await settleOpen();
    expect(openCalls.length).toBe(0);
  });

  test('does not open a stream when sessionId is empty', async () => {
    renderHook('', true);
    await settleOpen();
    expect(openCalls.length).toBe(0);
  });

  test('a COMPACTION_RECEIPT frame for this session is captured', async () => {
    renderHook('s-1');
    await settleOpen();
    fireEvent('compaction', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 's-1',
      trigger: 'auto',
      strategy: 'summarize-oldest',
      tokensBefore: 100,
      tokensAfter: 20,
      messagesBefore: 10,
      messagesAfter: 2,
      qualityScore: 0.9,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: true,
      validationPassed: true,
      outcome: 'applied',
    });
    expect(latestState?.receipts.length).toBe(1);
    expect(latestState?.receipts[0]?.sessionId).toBe('s-1');
  });

  test('a receipt for a DIFFERENT session is ignored; the domain is daemon-wide', async () => {
    renderHook('s-1');
    await settleOpen();
    fireEvent('compaction', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 's-OTHER',
      trigger: 'auto',
      strategy: 'x',
      tokensBefore: 1,
      tokensAfter: 1,
      messagesBefore: 1,
      messagesAfter: 1,
      qualityScore: 1,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: false,
      validationPassed: true,
      outcome: 'applied',
    });
    expect(latestState?.receipts.length).toBe(0);
  });

  test('a COMPACTION_CHECK frame for this session updates latestCheck', async () => {
    renderHook('s-1');
    await settleOpen();
    fireEvent('compaction', { type: 'COMPACTION_CHECK', sessionId: 's-1', tokenCount: 50, threshold: 100 });
    expect(latestState?.latestCheck?.tokenCount).toBe(50);
    expect(latestState?.latestCheck?.threshold).toBe(100);
  });

  test('a frame on a non-compaction event name is ignored', async () => {
    renderHook('s-1');
    await settleOpen();
    fireEvent('permissions', { type: 'COMPACTION_RECEIPT', sessionId: 's-1' });
    expect(latestState?.receipts.length).toBe(0);
  });

  test('receipts are capped at 20. An honest live log, not an unbounded leak', async () => {
    renderHook('s-1');
    await settleOpen();
    for (let i = 0; i < 25; i += 1) {
      fireEvent('compaction', {
        type: 'COMPACTION_RECEIPT',
        sessionId: 's-1',
        trigger: 'auto',
        strategy: `strategy-${i}`,
        tokensBefore: 1,
        tokensAfter: 1,
        messagesBefore: 1,
        messagesAfter: 1,
        qualityScore: 1,
        qualityGrade: 'A',
        lowQuality: false,
        instructionsReinjected: false,
        validationPassed: true,
        outcome: 'applied',
      });
    }
    expect(latestState?.receipts.length).toBe(20);
    expect(latestState?.receipts.at(-1)?.strategy).toBe('strategy-24');
  });

  test('unmount closes the opened stream exactly once', async () => {
    const { unmount } = renderHook('s-1');
    await settleOpen();
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(0);
    unmount();
    await settleOpen();
    expect(closers[0]?.mock.calls.length).toBe(1);
  });

  test('unmounting in the same tick it mounted never opens the stream', async () => {
    const { unmount } = renderHook('s-1');
    unmount();
    await settleOpen();
    expect(openCalls.length).toBe(0);
  });

  test('flipping enabled to false closes the stream and does not reopen it', async () => {
    const { rerender } = renderHook('s-1', true);
    await settleOpen();
    rerender('s-1', false);
    await settleOpen();
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(1);
    expect(openCalls.length).toBe(1);
  });

  test('switching session keeps the one stream and follows the new session', async () => {
    const { rerender } = renderHook('s-1');
    await settleOpen();
    rerender('s-2', true);
    await settleOpen();
    expect(openCalls.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(0);
    fireEvent('compaction', { type: 'COMPACTION_CHECK', sessionId: 's-2', tokenCount: 7, threshold: 10 });
    expect(latestState?.latestCheck?.tokenCount).toBe(7);
  });
});
