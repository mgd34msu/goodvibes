import { invalidateClientLifetime } from '../lib/client-lifetime';
import { getActiveRoute, setActiveRoute } from '../lib/relay-connection';
/**
 * useHostedSessionRealtime, an attached hosted session's live `turn`/`tools` output on
 * the shared stream's detail lane, and its own `hosted-session-update` frames on the
 * app lane.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

const DETAIL_PATH = '/api/control-plane/events?domains=tools,turn';
const APP_PATH = '/api/control-plane/events?domains=session';

const handlersByPath = new Map<string, ServerSentEventHandlers>();
const openCalls: string[] = [];
const closers: Array<{ path: string; close: ReturnType<typeof mock> }> = [];
const cleanups: Array<() => void> = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  client: {
    streams: {
      open: (pathOrUrl: string, handlers: ServerSentEventHandlers) => {
        openCalls.push(pathOrUrl);
        handlersByPath.set(pathOrUrl, handlers);
        const close = mock(() => {});
        closers.push({ path: pathOrUrl, close });
        return Promise.resolve(close);
      },
    },
  },
}));

const { useHostedSessionRealtime } = await import('./useHostedSessionRealtime');
type StreamFrame = import('../lib/hosted-session-stream').HostedStreamFrame;

function renderHook(attachedSessionId: string | null = null, enabled = true): {
  frames: StreamFrame[];
  lifecycleUpdates: unknown[];
  reconciles: () => number;
  state: () => { connected: boolean; error: string | null };
  rerender: (enabled: boolean) => void;
  unmount: () => void;
} {
  const frames: StreamFrame[] = [];
  const lifecycleUpdates: unknown[] = [];
  let reconcileCount = 0;

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
      onReconcile: () => { reconcileCount += 1; },
    });
    return null;
  }

  const doRender = (on: boolean) => {
    flushSync(() => {
      root.render(React.createElement(Harness, { on }));
    });
  };
  doRender(enabled);

  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    if (container.parentNode) container.parentNode.removeChild(container);
  };
  cleanups.push(unmount);

  return { frames, lifecycleUpdates, reconciles: () => reconcileCount, state: () => latest, rerender: doRender, unmount };
}

/** The stream owner opens on the next microtask and stores the closer one microtask later. */
async function settleOpen(): Promise<void> {
  for (let index = 0; index < 4; index++) await Promise.resolve();
}

const detail = () => handlersByPath.get(DETAIL_PATH);
const app = () => handlersByPath.get(APP_PATH);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settleOpen();
  closers.length = 0;
  handlersByPath.clear();
  openCalls.length = 0;
});

describe('useHostedSessionRealtime', () => {
  test('a transport error body (raw 401 JSON) never reaches the returned error', async () => {
    const { state } = renderHook();
    await settleOpen();
    flushSync(() => detail()?.onError?.(new Error('{"error":"Authentication required","code":"AUTH_REQUIRED","status":401}')));
    expect(state().error).not.toBeNull();
    expect(state().error).not.toContain('AUTH_REQUIRED');
    expect(state().error).not.toContain('{');
  });

  test('the terminal state does not claim it is still reconnecting', async () => {
    const { state } = renderHook();
    await settleOpen();
    flushSync(() => detail()?.onTerminate?.({ error: null, reconnectAttempts: 3 }));
    expect(state().connected).toBe(false);
    expect(state().error).not.toBeNull();
    expect(state().error?.toLowerCase()).not.toContain('reconnecting');
  });

  test('output rides the detail lane; lifecycle rides the app lane without a second session subscription', async () => {
    renderHook();
    await settleOpen();
    expect([...openCalls].sort()).toEqual([APP_PATH, DETAIL_PATH].sort());
  });

  test('the ready frame and a relay gap both ask the caller to reconcile the transcript', async () => {
    const { reconciles, state } = renderHook('hosted-1');
    await settleOpen();
    flushSync(() => detail()?.onReady?.({}));
    expect(state().connected).toBe(true);
    flushSync(() => detail()?.onEvent?.('relay-overflow', { dropped: 2 }));
    expect(reconciles()).toBe(2);
  });

  test('a hosted-session-update for the attached session calls onLifecycleUpdate', async () => {
    const { lifecycleUpdates } = renderHook('hosted-1');
    await settleOpen();
    const payload = { event: 'hosted-session-turn-ended', session: { id: 'hosted-1' }, createdAt: 1 };
    app()?.onEvent?.('hosted-session-update', payload);
    expect(lifecycleUpdates).toEqual([payload]);
  });

  test('a hosted-session-update for a DIFFERENT session does not call onLifecycleUpdate', async () => {
    const { lifecycleUpdates } = renderHook('hosted-1');
    await settleOpen();
    app()?.onEvent?.('hosted-session-update', { event: 'hosted-session-terminated', session: { id: 'hosted-other' }, createdAt: 1 });
    expect(lifecycleUpdates).toEqual([]);
  });

  test('turn/tools frames are forwarded only when attached and the sessionId matches', async () => {
    const { frames } = renderHook('hosted-1');
    await settleOpen();
    detail()?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    detail()?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-other', payload: { accumulated: 'nope' } });
    expect(frames.length).toBe(1);
    expect(frames[0].sessionId).toBe('hosted-1');
  });

  test('turn/tools frames are dropped entirely when nothing is attached', async () => {
    const { frames } = renderHook(null);
    await settleOpen();
    detail()?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    expect(frames.length).toBe(0);
  });
});

describe('useHostedSessionRealtime stream lifecycle', () => {
  test('unmount closes both lanes exactly once', async () => {
    const { unmount } = renderHook();
    await settleOpen();
    expect(closers.length).toBe(2);
    unmount();
    await settleOpen();
    for (const { close } of closers) expect(close.mock.calls.length).toBe(1);
  });

  test('disabled: never opens a stream', async () => {
    renderHook(null, false);
    await settleOpen();
    expect(openCalls.length).toBe(0);
  });
});

test('identity and route changes retire old stream callbacks, close the old stream and reopen', async () => {
  const { frames } = renderHook('s1');
  const originalRoute = getActiveRoute();
  try {
    await settleOpen();
    const old = detail();
    flushSync(() => invalidateClientLifetime());
    await settleOpen();
    expect(openCalls.length).toBe(4);
    expect(closers.filter(({ path }) => path === DETAIL_PATH)[0]?.close.mock.calls.length).toBe(1);
    old?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 's1', payload: { accumulated: 'late' } });
    expect(frames.length).toBe(0);
    flushSync(() => setActiveRoute(originalRoute === 'direct' ? 'relay' : 'direct'));
    await settleOpen();
    expect(openCalls.length).toBe(6);
  } finally {
    // The route is process-wide: restore it even when an assertion above fails.
    flushSync(() => setActiveRoute(originalRoute));
  }
});
