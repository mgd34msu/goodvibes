import { invalidateClientLifetime } from '../lib/client-lifetime';
import { getActiveRoute, setActiveRoute } from '../lib/relay-connection';
/**
 * useHostedSessionRealtime, one raw stream for hosted-session list liveness
 * (`hosted-session-update`, invalidates the list unconditionally) and, when
 * attached, the LIVE `turn`/`tools` output filtered to that session's id.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

let capturedHandlers: ServerSentEventHandlers | null = null;
const openCalls: string[] = [];
const closers: Array<ReturnType<typeof mock>> = [];
const cleanups: Array<() => void> = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
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

const { useHostedSessionRealtime } = await import('./useHostedSessionRealtime');
type StreamFrame = import('../lib/hosted-session-stream').HostedStreamFrame;

function renderHook(attachedSessionId: string | null = null, enabled = true): {
  invalidate: ReturnType<typeof mock>;
  frames: StreamFrame[];
  lifecycleUpdates: unknown[];
  state: () => { connected: boolean; error: string | null };
  rerender: (enabled: boolean) => void;
  unmount: () => void;
} {
  const client = new QueryClient();
  const invalidate = mock(() => Promise.resolve());
  (client as unknown as { invalidateQueries: unknown }).invalidateQueries = invalidate;

  const frames: StreamFrame[] = [];
  const lifecycleUpdates: unknown[] = [];

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latest: { connected: boolean; error: string | null } = { connected: false, error: null };
  function Harness({ on }: { on: boolean }) {
    latest = useHostedSessionRealtime({
      enabled: on,
      attachedSessionId,
      onStreamFrame: (frame) => frames.push(frame),
      onLifecycleUpdate: (payload) => lifecycleUpdates.push(payload),
    });
    return null;
  }

  const doRender = (on: boolean) => {
    flushSync(() => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness, { on })));
    });
  };
  doRender(enabled);

  // Registered for afterEach so a failed assertion cannot leave the root mounted.
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    if (container.parentNode) container.parentNode.removeChild(container);
  };
  cleanups.push(unmount);

  return {
    invalidate,
    frames,
    lifecycleUpdates,
    state: () => latest,
    rerender: doRender,
    unmount,
  };
}

/** The hook stores the closer from the open() promise one microtask later. */
async function settleOpen(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  closers.length = 0;
  capturedHandlers = null;
  openCalls.length = 0;
});

describe('useHostedSessionRealtime', () => {
  test('a transport error body (raw 401 JSON) never reaches the returned error', () => {
    const { state } = renderHook();
    flushSync(() => capturedHandlers?.onError?.(new Error('{"error":"Authentication required","code":"AUTH_REQUIRED","status":401}')));
    expect(state().error).not.toBeNull();
    expect(state().error).not.toContain('AUTH_REQUIRED');
    expect(state().error).not.toContain('{');
  });

  test('the terminal state does not claim it is still reconnecting', () => {
    const { state } = renderHook();
    flushSync(() => capturedHandlers?.onTerminate?.({ error: null, reconnectAttempts: 3 }));
    expect(state().connected).toBe(false);
    expect(state().error).not.toBeNull();
    expect(state().error?.toLowerCase()).not.toContain('reconnecting');
  });

  test('opens one stream narrowed to session, turn and tools', () => {
    renderHook();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toBe('/api/control-plane/events?domains=session,turn,tools');
  });

  test('a hosted-session-update frame always invalidates the hosted sessions list', () => {
    const { invalidate } = renderHook();
    capturedHandlers?.onEvent?.('hosted-session-update', {
      event: 'hosted-session-created',
      session: { id: 'hosted-1' },
      createdAt: 1,
    });
    expect(invalidate).toHaveBeenCalled();
    const arg = invalidate.mock.calls[0][0] as { queryKey: unknown };
    expect(arg.queryKey).toEqual(['hosted-sessions']);
  });

  test('a hosted-session-update for the attached session also calls onLifecycleUpdate', () => {
    const { lifecycleUpdates } = renderHook('hosted-1');
    const payload = { event: 'hosted-session-turn-ended', session: { id: 'hosted-1' }, createdAt: 1 };
    capturedHandlers?.onEvent?.('hosted-session-update', payload);
    expect(lifecycleUpdates).toEqual([payload]);
  });

  test('a hosted-session-update for a DIFFERENT session does not call onLifecycleUpdate', () => {
    const { lifecycleUpdates } = renderHook('hosted-1');
    capturedHandlers?.onEvent?.('hosted-session-update', { event: 'hosted-session-terminated', session: { id: 'hosted-other' }, createdAt: 1 });
    expect(lifecycleUpdates).toEqual([]);
  });

  test('turn/tools frames are forwarded only when attached and the sessionId matches', () => {
    const { frames } = renderHook('hosted-1');
    // Matching session: forwarded.
    capturedHandlers?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    // Different session: dropped.
    capturedHandlers?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-other', payload: { accumulated: 'nope' } });
    expect(frames.length).toBe(1);
    expect(frames[0].sessionId).toBe('hosted-1');
  });

  test('turn/tools frames are dropped entirely when nothing is attached', () => {
    const { frames } = renderHook(null);
    capturedHandlers?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    expect(frames.length).toBe(0);
  });
});

describe('useHostedSessionRealtime stream lifecycle', () => {
  test('unmount closes the opened stream exactly once', async () => {
    const { unmount } = renderHook();
    await settleOpen();
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(0);
    unmount();
    expect(closers[0]?.mock.calls.length).toBe(1);
  });

  test('flipping enabled to false closes the stream and does not reopen it', async () => {
    const { rerender } = renderHook(null, true);
    await settleOpen();
    rerender(false);
    expect(closers.length).toBe(1);
    expect(closers[0]?.mock.calls.length).toBe(1);
    expect(openCalls.length).toBe(1);
  });

  test('disabled: never opens a stream', () => {
    renderHook(null, false);
    expect(openCalls.length).toBe(0);
  });
});

test('identity and route changes retire old stream callbacks, close the old stream and reopen', async () => {
  const { invalidate } = renderHook();
  const originalRoute = getActiveRoute();
  try {
    await settleOpen();
    const old = capturedHandlers;
    flushSync(() => invalidateClientLifetime());
    expect(openCalls.length).toBe(2);
    expect(closers[0]?.mock.calls.length).toBe(1);
    old?.onEvent?.('hosted-session-update', { session: { id: 's1' } });
    old?.onEvent?.('session-update', { payload: { sessionId: 's1' } });
    expect(invalidate).not.toHaveBeenCalled();
    await settleOpen();
    flushSync(() => setActiveRoute(originalRoute === 'direct' ? 'relay' : 'direct'));
    expect(openCalls.length).toBe(3);
    expect(closers[1]?.mock.calls.length).toBe(1);
  } finally {
    // The route is process-wide: restore it even when an assertion above fails.
    flushSync(() => setActiveRoute(originalRoute));
  }
});
